import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AuthProviderError,
  type AuthProviderFailureCode,
} from "../../packages/contracts/src/auth-provider-client.ts";
import {
  passkeyActionFailure,
  type PasskeyFlowAuth,
  registerPasskey,
  removePasskey,
} from "../../apps/web/src/app/passkey-flows.ts";

function providerError(code: AuthProviderFailureCode): AuthProviderError {
  return new AuthProviderError(code, {
    status: 400,
    requestId: "req-1",
    retryAfterSeconds: null,
  });
}

type Account = {
  /** Account has a credential password. */
  hasPassword: boolean;
  /** Current session is inside the ten-minute fresh window. */
  fresh: boolean;
  /** Authenticator proof is owed before a removal. */
  needsFactor: boolean;
};

/** A server stand-in that keeps the same rules as the real provider. */
function fakeAuth(account: Account) {
  const calls: string[] = [];
  const sentPasswords: string[] = [];
  let factorProved = false;
  const requireFresh = () => {
    if (!account.fresh) throw providerError("FRESH_SIGN_IN_REQUIRED");
  };
  const auth: PasskeyFlowAuth = {
    reauthenticate: (input) => {
      calls.push("reauthenticate");
      sentPasswords.push(input.password);
      // Like the server: account check first, then blank input, then verify.
      if (!account.hasPassword) {
        return Promise.reject(providerError("PASSWORD_NOT_SET"));
      }
      if (input.password === "") {
        return Promise.reject(providerError("INVALID_PASSWORD"));
      }
      if (input.password !== "correct") {
        return Promise.reject(providerError("INVALID_PASSWORD"));
      }
      account.fresh = true;
      return Promise.resolve();
    },
    passkey: {
      generateRegisterOptions: () => {
        calls.push("generateRegisterOptions");
        requireFresh();
        return Promise.resolve({ challenge: "AQID" });
      },
      verifyRegistration: () => {
        calls.push("verifyRegistration");
        return Promise.resolve({
          id: "p1",
          name: null,
          credentialId: "c",
          deviceType: "multiDevice",
          backedUp: true,
          transports: [],
          createdAt: null,
        });
      },
      deletePasskey: () => {
        calls.push("deletePasskey");
        requireFresh();
        if (account.needsFactor && !factorProved) {
          throw providerError("FACTOR_PROOF_REQUIRED");
        }
        return Promise.resolve();
      },
    },
    twoFactor: {
      verifyTotp: () => {
        calls.push("verifyTotp");
        factorProved = true;
        return Promise.resolve();
      },
      verifyBackupCode: () => {
        calls.push("verifyBackupCode");
        factorProved = true;
        return Promise.resolve();
      },
    },
  };
  return { auth, calls, sentPasswords };
}

const credential = () => Promise.resolve({ id: "cred" });
const baseAdd = {
  name: "Laptop",
  password: "",
  passwordless: false,
  onPrompt: () => {},
  onPasswordless: () => {},
};

Deno.test("a fresh passwordless session adds a passkey without a password proof", async () => {
  const { auth, calls } = fakeAuth({
    hasPassword: false,
    fresh: true,
    needsFactor: false,
  });
  let learned = 0;
  const outcome = await registerPasskey(
    { auth, createCredential: credential },
    {
      ...baseAdd,
      signal: new AbortController().signal,
      onPasswordless: () => learned += 1,
    },
  );
  assertEquals(outcome, "registered");
  assertEquals(learned, 1);
  assertEquals(calls, [
    "reauthenticate",
    "generateRegisterOptions",
    "verifyRegistration",
  ]);
});

Deno.test("a fresh passwordless session removes a passkey, and skips the probe once known", async () => {
  const { auth, calls } = fakeAuth({
    hasPassword: false,
    fresh: true,
    needsFactor: false,
  });
  const input = {
    passkeyId: "p1",
    password: "",
    factorRequired: false,
    code: "",
    codeKind: "totp" as const,
    onPasswordless: () => {},
  };
  await removePasskey(auth, { ...input, passwordless: false });
  await removePasskey(auth, { ...input, passwordless: true });
  assertEquals(calls, [
    "reauthenticate",
    "deletePasskey",
    "deletePasskey",
  ]);
});

Deno.test("a stale passwordless session gets exactly one sign-out-then-sign-in, then succeeds", async () => {
  const account: Account = {
    hasPassword: false,
    fresh: false,
    needsFactor: false,
  };
  const { auth, calls } = fakeAuth(account);
  // The page's first submit knows nothing; it learns from PASSWORD_NOT_SET.
  let learned = false;
  const run = () =>
    registerPasskey({ auth, createCredential: credential }, {
      ...baseAdd,
      passwordless: learned,
      onPasswordless: () => learned = true,
      signal: new AbortController().signal,
    });

  let signOutOffers = 0;
  let outcome: string;
  try {
    outcome = await run();
  } catch (error) {
    const failure = passkeyActionFailure(error, learned);
    // The one offer: sign out, then sign in again.
    assertEquals(failure, { kind: "passwordNotSet" });
    signOutOffers += 1;
    account.fresh = true; // the new sign-in opens a fresh window
    outcome = await run();
  }
  assertEquals(outcome, "registered");
  assertEquals(signOutOffers, 1);
  // The password probe ran once; it is not repeated after it was learned.
  assertEquals(calls.filter((call) => call === "reauthenticate").length, 1);
});

Deno.test("a stale password account still routes to re-authentication, not sign-out", () => {
  assertEquals(
    passkeyActionFailure(providerError("FRESH_SIGN_IN_REQUIRED"), false),
    { kind: "reauthRequired" },
  );
});

Deno.test("a password account is re-proved in place before the action", async () => {
  const { auth, calls } = fakeAuth({
    hasPassword: true,
    fresh: false,
    needsFactor: false,
  });
  const outcome = await registerPasskey(
    { auth, createCredential: credential },
    {
      ...baseAdd,
      password: "correct",
      signal: new AbortController().signal,
    },
  );
  assertEquals(outcome, "registered");
  assertEquals(calls[0], "reauthenticate");
  const wrong = fakeAuth({
    hasPassword: true,
    fresh: false,
    needsFactor: false,
  });
  const error = await assertRejects(() =>
    registerPasskey({ auth: wrong.auth, createCredential: credential }, {
      ...baseAdd,
      password: "nope",
      signal: new AbortController().signal,
    })
  );
  assertEquals(passkeyActionFailure(error, false), { kind: "invalidPassword" });
});

Deno.test("passkey removal proves the factor in place with a backup code as well as a TOTP code", async () => {
  for (
    const [codeKind, expected] of [
      ["totp", "verifyTotp"],
      ["backup", "verifyBackupCode"],
    ] as const
  ) {
    const { auth, calls } = fakeAuth({
      hasPassword: true,
      fresh: false,
      needsFactor: true,
    });
    const input = {
      passkeyId: "p1",
      password: "correct",
      passwordless: false,
      factorRequired: false,
      code: "123456",
      codeKind,
      onPasswordless: () => {},
    };
    const error = await assertRejects(() => removePasskey(auth, input));
    assertEquals(passkeyActionFailure(error, false), {
      kind: "factorRequired",
    });
    await removePasskey(auth, { ...input, factorRequired: true });
    assertEquals(calls, [
      "reauthenticate",
      "deletePasskey",
      expected,
      "deletePasskey",
    ]);
  }
});

Deno.test("Cancel while the credential resolves never calls verify-registration", async () => {
  const { auth, calls } = fakeAuth({
    hasPassword: false,
    fresh: true,
    needsFactor: false,
  });
  const abort = new AbortController();
  const outcome = await registerPasskey(
    {
      auth,
      // Cancel lands while the browser is still resolving the credential.
      createCredential: () => {
        abort.abort();
        return credential();
      },
    },
    { ...baseAdd, passwordless: true, signal: abort.signal },
  );
  assertEquals(outcome, "aborted");
  assert(!calls.includes("verifyRegistration"));
});

Deno.test("a blank password field is sent as typed, so a password account is told it is wrong", async () => {
  const { auth, sentPasswords } = fakeAuth({
    hasPassword: true,
    fresh: false,
    needsFactor: false,
  });
  const error = await assertRejects(() =>
    registerPasskey({ auth, createCredential: credential }, {
      ...baseAdd,
      password: "",
      signal: new AbortController().signal,
    })
  );
  assertEquals(sentPasswords, [""]);
  assertEquals(passkeyActionFailure(error, false), { kind: "invalidPassword" });
});

Deno.test("a passwordless account is detected from a blank field via PASSWORD_NOT_SET", async () => {
  const { auth, sentPasswords, calls } = fakeAuth({
    hasPassword: false,
    fresh: true,
    needsFactor: false,
  });
  await registerPasskey({ auth, createCredential: credential }, {
    ...baseAdd,
    password: "",
    signal: new AbortController().signal,
  });
  assertEquals(sentPasswords, [""]);
  assert(calls.includes("verifyRegistration"));
});
