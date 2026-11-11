import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertUriSafePassword,
  BootstrapError,
  type BootstrapObservation,
  type BootstrapStatement,
  buildBootstrapStatements,
  DEFAULT_BOOTSTRAP_NAMES,
  parseScramVerifier,
  REQUIRED_ROLE_ATTRIBUTES,
  type RoleObservation,
  scramVerifier,
  scramVerifierMatches,
} from "../../apps/server/scripts/bootstrap-database.ts";

// RFC 7677 section 3 example exchange: user "user", password "pencil".
const RFC_SALT_B64 = "W22ZaJ0SNY7soEsUEjb6gQ==";
const RFC_STORED_KEY = "WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=";
const RFC_SERVER_KEY = "wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=";
const RFC_SERVER_SIGNATURE = "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";
const RFC_AUTH_MESSAGE =
  "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

Deno.test("scramVerifier reproduces the RFC 7677 keys for a fixed salt", async () => {
  const verifier = await scramVerifier("pencil", {
    salt: bytes(RFC_SALT_B64),
    iterations: 4096,
  });
  assertEquals(
    verifier,
    `SCRAM-SHA-256$4096:${RFC_SALT_B64}$${RFC_STORED_KEY}:${RFC_SERVER_KEY}`,
  );
  // The ServerKey signs the RFC AuthMessage into the published ServerSignature,
  // so the vector is tied to the RFC exchange and not only to this code.
  const parsed = parseScramVerifier(verifier);
  assert(parsed);
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(parsed.serverKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(RFC_AUTH_MESSAGE),
    ),
  );
  assertEquals(btoa(String.fromCharCode(...signature)), RFC_SERVER_SIGNATURE);
});

Deno.test("scramVerifier defaults to 4096 iterations and a fresh 16 byte salt", async () => {
  const first = parseScramVerifier(await scramVerifier("pencil"));
  const second = parseScramVerifier(await scramVerifier("pencil"));
  assert(first && second);
  assertEquals(first.iterations, 4096);
  assertEquals(bytes(first.salt).length, 16);
  assert(first.salt !== second.salt);
});

Deno.test("scramVerifierMatches recomputes with the stored salt and iterations", async () => {
  const stored = await scramVerifier("correct-horse", { iterations: 4096 });
  assert(await scramVerifierMatches("correct-horse", stored));
  assert(!await scramVerifierMatches("correct-horsf", stored));
  const other = await scramVerifier("correct-horse", { iterations: 5000 });
  assert(await scramVerifierMatches("correct-horse", other));
  for (
    const unusable of [
      null,
      undefined,
      "",
      "md5d41d8cd98f00b204e9800998ecf8427e",
      "plaintext-password",
      "SCRAM-SHA-256$4096:@@@$x:y",
      `SCRAM-SHA-256$99999999:${RFC_SALT_B64}$${RFC_STORED_KEY}:${RFC_SERVER_KEY}`,
      `SCRAM-SHA-256$0:${RFC_SALT_B64}$${RFC_STORED_KEY}:${RFC_SERVER_KEY}`,
    ]
  ) {
    assert(!await scramVerifierMatches("correct-horse", unusable));
  }
});

Deno.test("scramVerifier rejects a non-positive iteration count", async () => {
  await assertRejects(
    () => scramVerifier("pencil", { iterations: 0 }),
    BootstrapError,
    "SCRAM_ITERATIONS_INVALID",
  );
});

Deno.test("assertUriSafePassword accepts URI-safe passwords only", () => {
  assertEquals(assertUriSafePassword("Aa0._~-"), "Aa0._~-");
  for (
    const bad of [undefined, "", "a b", "a/b", "a@b", "a:b", "a%41", "a'b"]
  ) {
    assertThrows(
      () => assertUriSafePassword(bad),
      BootstrapError,
      "PASSWORD_MUST_BE_URI_SAFE",
    );
  }
});

const PASSWORDS = {
  owner: "owner-Plaintext.Secret_1",
  app: "app~Plaintext-Secret.2",
  inngest: "inngest.Plaintext~Secret-3",
} as const;

async function verifiers() {
  return {
    owner: await scramVerifier(PASSWORDS.owner),
    app: await scramVerifier(PASSWORDS.app),
    inngest: await scramVerifier(PASSWORDS.inngest),
  };
}

const current: RoleObservation = {
  attributes: REQUIRED_ROLE_ATTRIBUTES,
  passwordCurrent: true,
};

function observation(
  overrides: Partial<BootstrapObservation> = {},
): BootstrapObservation {
  return {
    owner: current,
    app: current,
    inngest: current,
    appHasMemberships: false,
    applicationDatabase: { owner: "bakery" },
    inngestDatabase: { owner: "inngest" },
    applicationConnectGranted: true,
    drainPending: false,
    ...overrides,
  };
}

function substrings(value: string, length: number): string[] {
  const found: string[] = [];
  for (let start = 0; start + length <= value.length; start += 1) {
    found.push(value.slice(start, start + length));
  }
  return found;
}

function assertNoPlaintext(statements: readonly BootstrapStatement[]) {
  const haystack = statements
    .flatMap((statement) => [statement.text, ...statement.params])
    .join("\n");
  for (const password of Object.values(PASSWORDS)) {
    assert(!haystack.includes(password), "plaintext password in statement");
    for (const piece of substrings(password, 8)) {
      assert(!haystack.includes(piece), `password fragment ${piece} leaked`);
    }
  }
}

Deno.test("buildBootstrapStatements creates everything from nothing with verifiers only", async () => {
  const statements = buildBootstrapStatements({
    names: DEFAULT_BOOTSTRAP_NAMES,
    verifiers: await verifiers(),
    observation: observation({
      owner: { passwordCurrent: false },
      app: { passwordCurrent: false },
      inngest: { passwordCurrent: false },
      applicationDatabase: {},
      inngestDatabase: {},
      applicationConnectGranted: false,
    }),
  });
  assertEquals(statements.map((statement) => statement.change), [
    "role:bakery:created",
    "role:bakery_app:created",
    "role:inngest:created",
    "database:bakery:created",
    "database:inngest:created",
    "database:bakery:connect:bakery_app",
  ]);
  assertEquals(
    statements[0]!.text,
    "create role %I login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L",
  );
  for (const statement of statements.slice(0, 3)) {
    assert(statement.params[1]?.startsWith("SCRAM-SHA-256$4096:"));
  }
  assertNoPlaintext(statements);
});

Deno.test("buildBootstrapStatements alters only differing attributes and stale passwords", async () => {
  const statements = buildBootstrapStatements({
    names: DEFAULT_BOOTSTRAP_NAMES,
    verifiers: await verifiers(),
    observation: observation({
      owner: {
        attributes: {
          ...REQUIRED_ROLE_ATTRIBUTES,
          createDatabase: true,
          canLogin: false,
        },
        passwordCurrent: true,
      },
      app: { attributes: REQUIRED_ROLE_ATTRIBUTES, passwordCurrent: false },
      inngest: {
        attributes: { ...REQUIRED_ROLE_ATTRIBUTES, bypassRowSecurity: true },
        passwordCurrent: false,
      },
      applicationDatabase: { owner: "postgres" },
      inngestDatabase: { owner: "postgres" },
    }),
  });
  assertEquals(
    statements.map((statement) => [statement.change, statement.text]),
    [
      ["role:bakery:attributes", "alter role %I login nocreatedb"],
      ["role:bakery_app:password", "alter role %I password %L"],
      ["role:inngest:attributes", "alter role %I nobypassrls"],
      ["role:inngest:password", "alter role %I password %L"],
      ["database:bakery:owner", "alter database %I owner to %I"],
      ["database:inngest:owner", "alter database %I owner to %I"],
    ],
  );
  assertNoPlaintext(statements);
});

Deno.test("buildBootstrapStatements is empty when everything is current", async () => {
  const statements = buildBootstrapStatements({
    names: DEFAULT_BOOTSTRAP_NAMES,
    verifiers: await verifiers(),
    observation: observation(),
  });
  assertEquals(statements, []);
  assertNoPlaintext(statements);
});

Deno.test("buildBootstrapStatements leaves CONNECT to a drain in progress", async () => {
  const statements = buildBootstrapStatements({
    names: DEFAULT_BOOTSTRAP_NAMES,
    verifiers: await verifiers(),
    observation: observation({
      applicationConnectGranted: false,
      drainPending: true,
    }),
  });
  assertEquals(statements, []);
});

Deno.test("buildBootstrapStatements refuses a bakery_app with role memberships", () => {
  assertThrows(
    () =>
      buildBootstrapStatements({
        names: DEFAULT_BOOTSTRAP_NAMES,
        verifiers: {
          owner: "x",
          app: "x",
          inngest: "x",
        },
        observation: observation({ appHasMemberships: true }),
      }),
    BootstrapError,
    "BAKERY_APP_ROLE_MEMBERSHIP_UNSAFE",
  );
});

Deno.test("buildBootstrapStatements rejects unsafe or duplicate names", () => {
  const input = {
    verifiers: { owner: "x", app: "x", inngest: "x" },
    observation: observation(),
  };
  assertThrows(
    () =>
      buildBootstrapStatements({
        ...input,
        names: { ...DEFAULT_BOOTSTRAP_NAMES, owner: 'a"; drop' },
      }),
    BootstrapError,
    "BOOTSTRAP_NAME_INVALID",
  );
  assertThrows(
    () =>
      buildBootstrapStatements({
        ...input,
        names: { ...DEFAULT_BOOTSTRAP_NAMES, app: "bakery" },
      }),
    BootstrapError,
    "BOOTSTRAP_ROLE_NAMES_NOT_DISTINCT",
  );
});
