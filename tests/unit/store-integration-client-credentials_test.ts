import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { PrincipalType } from "../../packages/contracts/src/contracts.ts";
import {
  getClientCredentials,
  putClientCredentials,
} from "../../apps/server/src/modules/integrations/client-credentials.ts";

/**
 * Provider OAuth client credentials without a database (#410).
 *
 * What these pin is everything that must be decided before a row is touched:
 * which provider is served, who may call, what a credential may look like, and what
 * a version precondition means. The integration file runs the same handlers against
 * Postgres, where sealing, the secret revision and the one-row-per-provider key
 * actually execute.
 */

const PRINCIPAL = "11111111-1111-4111-8111-111111111111";
const BASE = "https://bakery.example";
const dependencies = { secretsKey: undefined, publicBaseUrl: BASE };

type Statement = { sql: string; values: readonly unknown[] };

function stand(row: Record<string, unknown> | null = null) {
  const recorded: Statement[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      recorded.push({ sql, values });
      return Promise.resolve({
        rows:
          row !== null && /from bakery\.integration_app_registrations/.test(sql)
            ? [row]
            : [],
        rowCount: 0,
      });
    },
  };
  return { transaction, recorded };
}

function context(
  transaction: unknown,
  options: {
    provider?: string;
    expectedVersion?: number;
    administrator?: boolean;
    principalType?: string;
  } = {},
): ActionContext {
  return {
    params: { provider: options.provider ?? "linear" },
    signal: new AbortController().signal,
    requestId: "request-1",
    traceId: "trace-1",
    transaction,
    principal: { principalId: PRINCIPAL },
    authority: {
      installationAdministrator: options.administrator ?? true,
      subject: {
        principalId: PRINCIPAL,
        principalType: options.principalType ?? PrincipalType.Human,
      },
    },
    commandMetadata: {
      operation: "integrationClientCredentials.put",
      idempotencyKey: "key-1",
      target: "linear",
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedVersion: options.expectedVersion }),
    },
  } as unknown as ActionContext;
}

const storedRow = {
  id: "22222222-2222-4222-8222-222222222222",
  client_id: "linear-client",
  version: 3,
  secret_id: "33333333-3333-4333-8333-333333333333",
  revision: 2,
  saved_at: new Date("2026-11-19T10:00:00.000Z"),
};

const valid = { clientId: "linear-client", clientSecret: "lin_oauth_secret" };

Deno.test("an unregistered provider reads as not configured, with the callback to give it", async () => {
  const { transaction } = stand(null);
  const result = await getClientCredentials(context(transaction), dependencies);
  assertEquals(result, {
    provider: "linear",
    configured: false,
    clientId: null,
    clientSecretSavedAt: null,
    signingSecretSavedAt: null,
    callbackUrl: `${BASE}/v1/integration-auth/linear/callback`,
    version: 0,
  });
});

Deno.test("a registered provider shows its client ID and when the secret was saved, never the secret", async () => {
  const { transaction } = stand(storedRow);
  const result = await getClientCredentials(context(transaction), dependencies);
  assertEquals(result.configured, true);
  assertEquals(result.clientId, "linear-client");
  assertEquals(result.clientSecretSavedAt, "2026-11-19T10:00:00.000Z");
  assertEquals(result.version, 3);
  // The projection is a fixed set of fields: there is nowhere for a secret, its
  // ciphertext, its record id or its revision to ride along.
  assertEquals(Object.keys(result).sort(), [
    "callbackUrl",
    "clientId",
    "clientSecretSavedAt",
    "configured",
    "provider",
    "signingSecretSavedAt",
    "version",
  ]);
  assertEquals(result.signingSecretSavedAt, null);
  assertEquals(JSON.stringify(result).includes("secret_id"), false);
});

Deno.test("only a provider whose manifest asks for client credentials is served, and the answer is the same for all others", async () => {
  for (const provider of ["github", "jira", "nope", "", "LINEAR", "linear/x"]) {
    for (
      const call of [
        (transaction: unknown) =>
          getClientCredentials(
            context(transaction, { provider }),
            dependencies,
          ),
        (transaction: unknown) =>
          putClientCredentials(
            context(transaction, { provider }),
            valid,
            dependencies,
          ),
      ]
    ) {
      const { transaction, recorded } = stand(storedRow);
      const error = await assertRejects(() => call(transaction), StandardError);
      assertEquals(error.code, "RESOURCE_NOT_FOUND", provider);
      // Refused before the database is asked anything.
      assertEquals(recorded, [], provider);
    }
  }
});

Deno.test("only an installation administrator may read or write", async () => {
  for (
    const options of [
      { administrator: false },
      { principalType: "worker" },
    ]
  ) {
    for (
      const call of [
        (transaction: unknown) =>
          getClientCredentials(context(transaction, options), dependencies),
        (transaction: unknown) =>
          putClientCredentials(
            context(transaction, options),
            valid,
            dependencies,
          ),
      ]
    ) {
      const { transaction, recorded } = stand(storedRow);
      const error = await assertRejects(() => call(transaction), StandardError);
      assertEquals(error.code, "AUTH_FORBIDDEN", JSON.stringify(options));
      assertEquals(recorded, []);
    }
  }
});

Deno.test("a client ID or secret that is empty, padded, oversized or has a control character is refused before anything is read", async () => {
  const bad: [string, Partial<typeof valid>, string][] = [
    ["empty id", { clientId: "" }, "clientId"],
    ["padded id", { clientId: " id" }, "clientId"],
    ["trailing space id", { clientId: "id " }, "clientId"],
    ["oversized id", { clientId: "x".repeat(201) }, "clientId"],
    ["newline in id", { clientId: "id\\nx".replace("\\n", "\n") }, "clientId"],
    ["tab in id", { clientId: "id\tx" }, "clientId"],
    ["nul in id", { clientId: "id\u0000x" }, "clientId"],
    ["empty secret", { clientSecret: "" }, "clientSecret"],
    ["padded secret", { clientSecret: " s" }, "clientSecret"],
    ["oversized secret", { clientSecret: "x".repeat(4097) }, "clientSecret"],
    ["newline in secret", { clientSecret: "s\nx" }, "clientSecret"],
    ["delete in secret", { clientSecret: "s\u007fx" }, "clientSecret"],
  ];
  for (const [name, override, field] of bad) {
    const { transaction, recorded } = stand(null);
    const error = await assertRejects(
      () =>
        putClientCredentials(
          context(transaction),
          { ...valid, ...override },
          dependencies,
        ),
      StandardError,
      "",
      name,
    );
    assertEquals(error.code, "UNPROCESSABLE", name);
    const issues = (error.params as { issues?: { path: string[] }[] }).issues;
    assertEquals(issues?.[0]?.path, [field], name);
    assertEquals(recorded, [], `${name} reached the database`);
  }
});

Deno.test("the boundary lengths are accepted: 200 for an ID and 4096 for a secret reach the version check", async () => {
  for (
    const [name, input] of [
      ["200 character id", { ...valid, clientId: "x".repeat(200) }],
      ["4096 character secret", { ...valid, clientSecret: "x".repeat(4096) }],
    ] as const
  ) {
    const { transaction } = stand(storedRow);
    // Not refused as invalid: it gets as far as the missing If-Match.
    const error = await assertRejects(
      () => putClientCredentials(context(transaction), input, dependencies),
      StandardError,
      "",
      name,
    );
    assertEquals(error.code, "PRECONDITION_REQUIRED", name);
  }
});

Deno.test("a replacement must carry the version it read, and nothing is written when it does not", async () => {
  // Registered, no If-Match.
  {
    const { transaction, recorded } = stand(storedRow);
    const error = await assertRejects(
      () => putClientCredentials(context(transaction), valid, dependencies),
      StandardError,
    );
    assertEquals(error.code, "PRECONDITION_REQUIRED");
    assert(recorded.every(({ sql }) => /^\s*select/i.test(sql)));
  }
  // Registered, a stale version.
  {
    const { transaction, recorded } = stand(storedRow);
    const error = await assertRejects(
      () =>
        putClientCredentials(
          context(transaction, { expectedVersion: 2 }),
          valid,
          dependencies,
        ),
      StandardError,
    );
    assertEquals(error.code, "PRECONDITION_FAILED");
    assert(recorded.every(({ sql }) => /^\s*select/i.test(sql)));
  }
  // Nothing registered, yet a version was sent: there is nothing to hold it to.
  {
    const { transaction, recorded } = stand(null);
    const error = await assertRejects(
      () =>
        putClientCredentials(
          context(transaction, { expectedVersion: 1 }),
          valid,
          dependencies,
        ),
      StandardError,
    );
    assertEquals(error.code, "PRECONDITION_FAILED");
    assert(recorded.every(({ sql }) => /^\s*select/i.test(sql)));
  }
});

Deno.test("the row is locked before the version is judged", async () => {
  const { transaction, recorded } = stand(storedRow);
  await assertRejects(
    () =>
      putClientCredentials(
        context(transaction, { expectedVersion: 99 }),
        valid,
        dependencies,
      ),
    StandardError,
  );
  const read = recorded.find(({ sql }) =>
    /from bakery\.integration_app_registrations/.test(sql)
  )!;
  assert(/for update of registration/.test(read.sql));
  assertEquals(read.values, ["linear"]);
});
