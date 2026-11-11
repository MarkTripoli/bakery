import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AuthProviderError,
  type AuthProviderFailureCode,
  createAuthProviderClient,
} from "../../packages/contracts/src/auth-provider-client.ts";

const baseUrl = "http://auth-provider-client.test";

type RequestCapture = { input: RequestInfo | URL; init?: RequestInit };

function stubFetch(
  respond: (capture: RequestCapture) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: RequestCapture[] } {
  const calls: RequestCapture[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const capture = { input, init };
    calls.push(capture);
    return Promise.resolve(respond(capture));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function providerError(
  status: number,
  code: string,
  headers: HeadersInit = {},
): Response {
  return Response.json({ code, message: "raw provider message detail" }, {
    status,
    headers,
  });
}

Deno.test("every request sends credentials, JSON headers, and a request id", async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() =>
    Response.json({ twoFactorRedirect: false })
  );
  const client = createAuthProviderClient({
    baseUrl,
    fetch: fetchImpl,
    createRequestId: () => "request-id-fixed",
  });
  await client.signInEmail({ email: "a@example.test", password: "pw" });
  assertEquals(calls.length, 1);
  const [{ input, init }] = calls;
  assertEquals(String(input), `${baseUrl}/api/auth/sign-in/email`);
  assertEquals(init?.method, "POST");
  assertEquals(init?.credentials, "include");
  const headers = new Headers(init?.headers);
  assertEquals(headers.get("content-type"), "application/json");
  assertEquals(headers.get("accept"), "application/json");
  assertEquals(headers.get("X-Request-Id"), "request-id-fixed");
  assertEquals(JSON.parse(String(init?.body)), {
    email: "a@example.test",
    password: "pw",
  });
});

Deno.test("signInEmail resolves signed-in when twoFactorRedirect is absent or false", async () => {
  for (const body of [{}, { twoFactorRedirect: false }]) {
    const { fetch: fetchImpl } = stubFetch(() => Response.json(body));
    const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
    assertEquals(
      await client.signInEmail({ email: "a@example.test", password: "pw" }),
      { kind: "signed-in" },
    );
  }
});

Deno.test("signInEmail resolves two-factor-required when twoFactorRedirect is true", async () => {
  const { fetch: fetchImpl } = stubFetch(() =>
    Response.json({ twoFactorRedirect: true })
  );
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  assertEquals(
    await client.signInEmail({ email: "a@example.test", password: "pw" }),
    { kind: "two-factor-required" },
  );
});

Deno.test("signUpEmail always resolves submitted, including a null-token anti-enumeration reply", async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() =>
    Response.json({ token: null })
  );
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  assertEquals(
    await client.signUpEmail({
      name: "New Person",
      email: "new@example.test",
      password: "pw",
    }),
    { kind: "submitted" },
  );
  const [{ input, init }] = calls;
  assertEquals(String(input), `${baseUrl}/api/auth/sign-up/email`);
  assertEquals(JSON.parse(String(init?.body)), {
    name: "New Person",
    email: "new@example.test",
    password: "pw",
    rememberMe: false,
  });
});

Deno.test("signOut and two-factor verify/disable resolve void on success", async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => Response.json({}));
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  assertEquals(await client.signOut(), undefined);
  assertEquals(
    await client.twoFactor.verifyTotp({ code: "123456" }),
    undefined,
  );
  assertEquals(
    await client.twoFactor.verifyBackupCode({ code: "abcdef" }),
    undefined,
  );
  assertEquals(await client.twoFactor.disable({ password: "pw" }), undefined);
  assertEquals(
    calls.map(({ input }) => String(input)),
    [
      `${baseUrl}/api/auth/sign-out`,
      `${baseUrl}/api/auth/two-factor/verify-totp`,
      `${baseUrl}/api/auth/two-factor/verify-backup-code`,
      `${baseUrl}/api/auth/two-factor/disable`,
    ],
  );
});

Deno.test("two-factor enable renames totpURI to totpUri and passes backup codes through", async () => {
  const { fetch: fetchImpl } = stubFetch(() =>
    Response.json({
      totpURI: "otpauth://totp/Bakery?secret=ABCDEF",
      backupCodes: ["one", "two"],
    })
  );
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  assertEquals(await client.twoFactor.enable({ password: "pw" }), {
    totpUri: "otpauth://totp/Bakery?secret=ABCDEF",
    backupCodes: ["one", "two"],
  });
});

Deno.test("two-factor generateBackupCodes returns the fresh codes", async () => {
  const { fetch: fetchImpl } = stubFetch(() =>
    Response.json({ backupCodes: ["fresh-1", "fresh-2"] })
  );
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  assertEquals(await client.twoFactor.generateBackupCodes({ password: "pw" }), {
    backupCodes: ["fresh-1", "fresh-2"],
  });
});

const mappingRows: ReadonlyArray<
  { status: number; code: string; expected: AuthProviderFailureCode }
> = [
  {
    status: 401,
    code: "INVALID_EMAIL_OR_PASSWORD",
    expected: "INVALID_CREDENTIALS",
  },
  {
    status: 422,
    code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
    expected: "ACCOUNT_EXISTS",
  },
  { status: 400, code: "PASSWORD_TOO_SHORT", expected: "WEAK_PASSWORD" },
  { status: 400, code: "PASSWORD_TOO_LONG", expected: "WEAK_PASSWORD" },
  { status: 401, code: "INVALID_CODE", expected: "TWO_FACTOR_INVALID" },
  { status: 401, code: "INVALID_BACKUP_CODE", expected: "TWO_FACTOR_INVALID" },
  {
    status: 401,
    code: "INVALID_TWO_FACTOR_COOKIE",
    expected: "TWO_FACTOR_SESSION_EXPIRED",
  },
  {
    status: 400,
    code: "INVALID_PASSWORD",
    expected: "INVALID_CREDENTIALS",
  },
  { status: 403, code: "TWO_FACTOR_REQUIRED", expected: "TWO_FACTOR_REQUIRED" },
  {
    status: 403,
    code: "FACTOR_PROOF_REQUIRED",
    expected: "FACTOR_PROOF_REQUIRED",
  },
  {
    status: 403,
    code: "FRESH_SIGN_IN_REQUIRED",
    expected: "FRESH_SIGN_IN_REQUIRED",
  },
  { status: 429, code: "ACCOUNT_TEMPORARILY_LOCKED", expected: "LOCKED" },
  {
    status: 403,
    code: "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
    expected: "CROSS_ORIGIN_BLOCKED",
  },
  {
    status: 403,
    code: "MISSING_OR_NULL_ORIGIN",
    expected: "CROSS_ORIGIN_BLOCKED",
  },
  { status: 429, code: "SOME_OTHER_RATE_LIMIT_CODE", expected: "RATE_LIMITED" },
  { status: 500, code: "SOMETHING_UNMAPPED", expected: "UNAVAILABLE" },
];

for (const row of mappingRows) {
  Deno.test(`provider code ${row.code} (${row.status}) maps to ${row.expected}`, async () => {
    const { fetch: fetchImpl } = stubFetch(() =>
      providerError(row.status, row.code)
    );
    const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
    const error = await assertRejects(
      () => client.signInEmail({ email: "a@example.test", password: "pw" }),
      AuthProviderError,
    );
    assertEquals(error.code, row.expected);
    assertEquals(error.status, row.status);
    assert(
      !error.message.includes("raw provider message detail"),
      "AuthProviderError.message must never contain the provider message",
    );
  });
}

Deno.test("RATE_LIMITED carries retryAfterSeconds from X-Retry-After, falling back to Retry-After", async () => {
  const { fetch: xRetryFetch } = stubFetch(() =>
    providerError(429, "UNKNOWN_LIMIT", { "X-Retry-After": "12" })
  );
  const xRetryClient = createAuthProviderClient({
    baseUrl,
    fetch: xRetryFetch,
  });
  const xRetryError = await assertRejects(
    () => xRetryClient.signInEmail({ email: "a@example.test", password: "pw" }),
    AuthProviderError,
  );
  assertEquals(xRetryError.code, "RATE_LIMITED");
  assertEquals(xRetryError.retryAfterSeconds, 12);

  const { fetch: retryAfterFetch } = stubFetch(() =>
    providerError(429, "UNKNOWN_LIMIT", { "Retry-After": "7" })
  );
  const retryAfterClient = createAuthProviderClient({
    baseUrl,
    fetch: retryAfterFetch,
  });
  const retryAfterError = await assertRejects(
    () =>
      retryAfterClient.signInEmail({ email: "a@example.test", password: "pw" }),
    AuthProviderError,
  );
  assertEquals(retryAfterError.code, "RATE_LIMITED");
  assertEquals(retryAfterError.retryAfterSeconds, 7);
});

Deno.test("retryAfterSeconds is null for blank, fractional, and HTTP-date Retry-After values", async () => {
  for (
    const value of ["", "12.5", "Wed, 21 Oct 2026 07:28:00 GMT"]
  ) {
    const { fetch: fetchImpl } = stubFetch(() =>
      providerError(429, "UNKNOWN_LIMIT", { "Retry-After": value })
    );
    const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
    const error = await assertRejects(
      () => client.signInEmail({ email: "a@example.test", password: "pw" }),
      AuthProviderError,
    );
    assertEquals(error.code, "RATE_LIMITED");
    assertEquals(
      error.retryAfterSeconds,
      null,
      `retryAfterSeconds must be null for Retry-After: ${
        JSON.stringify(value)
      }`,
    );
  }
});

Deno.test("non-RATE_LIMITED failures never carry a retryAfterSeconds value", async () => {
  const { fetch: fetchImpl } = stubFetch(() =>
    providerError(429, "ACCOUNT_TEMPORARILY_LOCKED", { "Retry-After": "30" })
  );
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  const error = await assertRejects(
    () => client.signInEmail({ email: "a@example.test", password: "pw" }),
    AuthProviderError,
  );
  assertEquals(error.code, "LOCKED");
  assertEquals(error.retryAfterSeconds, null);
});

Deno.test("fetch throwing or aborting collapses to NETWORK, never containing the cause message", async () => {
  const thrownFetch = (() =>
    Promise.reject(
      new TypeError("failed to fetch: dns lookup failed"),
    )) as typeof fetch;
  const throwingClient = createAuthProviderClient({
    baseUrl,
    fetch: thrownFetch,
  });
  const throwError = await assertRejects(
    () =>
      throwingClient.signInEmail({ email: "a@example.test", password: "pw" }),
    AuthProviderError,
  );
  assertEquals(throwError.code, "NETWORK");
  assertEquals(throwError.status, null);
  assert(!throwError.message.includes("dns lookup failed"));

  const controller = new AbortController();
  controller.abort();
  const abortFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  const abortClient = createAuthProviderClient({ baseUrl, fetch: abortFetch });
  const abortError = await assertRejects(
    () =>
      abortClient.signInEmail(
        { email: "a@example.test", password: "pw" },
        controller.signal,
      ),
    AuthProviderError,
  );
  assertEquals(abortError.code, "NETWORK");
});

Deno.test("a success body missing required fields becomes UNAVAILABLE, not a thrown parse error", async () => {
  const { fetch: fetchImpl } = stubFetch(() =>
    new Response("not json", { status: 200 })
  );
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  const error = await assertRejects(
    () => client.twoFactor.enable({ password: "pw" }),
    AuthProviderError,
  );
  assertEquals(error.code, "UNAVAILABLE");
  assertEquals(error.status, 200);
});

Deno.test("signInEmail with a non-JSON 200 body becomes UNAVAILABLE, never signed-in", async () => {
  const { fetch: fetchImpl } = stubFetch(() =>
    new Response("not json", { status: 200 })
  );
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  const error = await assertRejects(
    () => client.signInEmail({ email: "a@example.test", password: "pw" }),
    AuthProviderError,
  );
  assertEquals(error.code, "UNAVAILABLE");
  assertEquals(error.status, 200);
});

Deno.test("changePassword posts the three fields and maps its own failure codes", async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => Response.json({}));
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });
  await client.changePassword({
    currentPassword: "old-password",
    newPassword: "new-password",
    revokeOtherSessions: true,
  });
  assertEquals(String(calls[0].input), `${baseUrl}/api/auth/change-password`);
  assertEquals(JSON.parse(String(calls[0].init?.body)), {
    currentPassword: "old-password",
    newPassword: "new-password",
    revokeOtherSessions: true,
  });

  for (
    const [code, expected] of [
      ["INVALID_PASSWORD", "INVALID_PASSWORD"],
      ["PASSWORD_TOO_SHORT", "PASSWORD_TOO_SHORT"],
      ["PASSWORD_TOO_LONG", "PASSWORD_TOO_LONG"],
      ["FRESH_SIGN_IN_REQUIRED", "FRESH_SIGN_IN_REQUIRED"],
    ] as const
  ) {
    const failing = createAuthProviderClient({
      baseUrl,
      fetch: stubFetch(() => providerError(400, code)).fetch,
    });
    const error = await assertRejects(
      () =>
        failing.changePassword({
          currentPassword: "a",
          newPassword: "b",
          revokeOtherSessions: false,
        }),
      AuthProviderError,
    );
    assertEquals(error.code, expected);
  }
});

Deno.test("passkey methods map public fields only and classify the last-method refusal", async () => {
  const record = {
    id: "pk-1",
    name: "Laptop",
    credentialID: "cred-1",
    deviceType: "multiDevice",
    backedUp: true,
    transports: "internal,hybrid",
    createdAt: "2026-01-02T03:04:05.000Z",
    publicKey: "must-not-surface",
    userId: "user-1",
  };
  const { fetch: fetchImpl, calls } = stubFetch(({ input }) => {
    const url = String(input);
    if (url.includes("/generate-register-options")) {
      return Response.json({ challenge: "abc", rp: { name: "Bakery" } });
    }
    if (url.endsWith("/list-user-passkeys")) return Response.json([record]);
    if (url.endsWith("/update-passkey")) {
      return Response.json({ passkey: { ...record, name: "Desk" } });
    }
    return Response.json(record);
  });
  const client = createAuthProviderClient({ baseUrl, fetch: fetchImpl });

  const options = await client.passkey.generateRegisterOptions({ name: "A B" });
  assertEquals(options.challenge, "abc");
  assertEquals(calls[0].init?.method, "GET");
  assertEquals(
    String(calls[0].input),
    `${baseUrl}/api/auth/passkey/generate-register-options?name=A%20B`,
  );

  const registered = await client.passkey.verifyRegistration({
    response: { id: "cred-1" },
    name: "Laptop",
  });
  assertEquals(registered, {
    id: "pk-1",
    name: "Laptop",
    credentialId: "cred-1",
    deviceType: "multiDevice",
    backedUp: true,
    transports: ["internal", "hybrid"],
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  assertEquals((await client.passkey.listUserPasskeys()).length, 1);
  assertEquals(
    (await client.passkey.updatePasskey({ id: "pk-1", name: "Desk" })).name,
    "Desk",
  );
  await client.passkey.deletePasskey({ id: "pk-1" });
  assertEquals(
    String(calls.at(-1)?.input),
    `${baseUrl}/api/auth/passkey/delete-passkey`,
  );

  const refused = createAuthProviderClient({
    baseUrl,
    fetch: stubFetch(() => providerError(403, "LAST_SIGN_IN_METHOD")).fetch,
  });
  const error = await assertRejects(
    () => refused.passkey.deletePasskey({ id: "pk-1" }),
    AuthProviderError,
  );
  assertEquals(error.code, "LAST_SIGN_IN_METHOD");

  const malformed = createAuthProviderClient({
    baseUrl,
    fetch: stubFetch(() => Response.json({ nope: true })).fetch,
  });
  const unavailable = await assertRejects(
    () => malformed.passkey.listUserPasskeys(),
    AuthProviderError,
  );
  assertEquals(unavailable.code, "UNAVAILABLE");
});
