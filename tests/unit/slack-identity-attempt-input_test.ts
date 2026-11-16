import { assertEquals } from "@std/assert";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import {
  claimSlackIdentityAttempt,
  createSlackIdentityAttempt,
} from "../../apps/server/src/modules/integrations/slack-identity-attempts.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";

// Input that is wrong is refused before the database is touched. A NUL byte in
// the session id used to get past the checks and surface as a database error
// ("invalid byte sequence for encoding UTF8: 0x00") that aborts the caller's
// transaction; it is now a refusal. The id comes from the server session, so
// this is a guard on the module's own contract, not a reachable attack.

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
/** A session row id, which is what the binding must be. */
const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
/** What a browser session token looks like: opaque, not a UUID. */
const SESSION_TOKEN = "sess_lZ8pQ2rT4vW6xY0aB1cD3eF5gH7jK9mN";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000002";

/** A transaction that records what it is asked and answers every query with no rows. */
function recordingTransaction({ membership = false } = {}) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const transaction = {
    query: (sql: string, values?: unknown[]) => {
      queries.push(sql);
      params.push(values ?? []);
      // By default nothing matches, which is what the refusal tests expect. With
      // `member` the membership check and the insert answer, so a create that
      // would otherwise stop early can be observed writing its row.
      if (!membership) return Promise.resolve({ rows: [], rowCount: 0 });
      if (sql.includes("organization_memberships")) {
        return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
      }
      if (sql.startsWith("insert into bakery.slack_identity_attempts")) {
        return Promise.resolve({
          rows: [{ expiresAt: "2026-01-01T00:00:00.000Z" }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as PgTransactionClient;
  return { transaction, params, queries };
}

async function createInput(sessionId: string) {
  return {
    organizationId: ORGANIZATION_ID,
    principalId: PRINCIPAL_ID,
    sessionId,
    binding: {
      appId: "A0123456789",
      clientId: "1234567890.1234567890",
      teamId: "T0123456789",
    },
    secretsKey: await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    keyId: "key-1",
  };
}

Deno.test("create refuses a session id with a NUL byte before the database is touched", async () => {
  for (const sessionId of ["session\u0000id", "\u0000", "tail\u0000"]) {
    const { transaction, queries } = recordingTransaction();
    const result = await createSlackIdentityAttempt(
      transaction,
      await createInput(sessionId) as never,
    );
    assertEquals(result, { ok: false, reason: "malformed" }, sessionId);
    assertEquals(queries.length, 0, "the database was touched");
  }
});

Deno.test("create still accepts an ordinary session id and reaches the database", async () => {
  const { transaction, queries } = recordingTransaction();
  const result = await createSlackIdentityAttempt(
    transaction,
    await createInput(SESSION_ID) as never,
  );
  // The recording transaction has no membership row, so the membership check
  // is where it stops: the input itself was accepted.
  assertEquals(result, { ok: false, reason: "not_a_member" });
  assertEquals(queries.length, 1);
});

Deno.test("claim refuses a session id with a NUL byte before the database is touched", async () => {
  for (const sessionId of ["session\u0000id", "\u0000"]) {
    const { transaction, queries } = recordingTransaction();
    const result = await claimSlackIdentityAttempt(transaction, {
      state: "state-token",
      sessionId,
      principalId: PRINCIPAL_ID,
    } as never);
    assertEquals(result, { ok: false, reason: "refused" }, sessionId);
    assertEquals(queries.length, 0, "the database was touched");
  }
});

Deno.test("claim still accepts an ordinary session id and reaches the database", async () => {
  const { transaction, queries } = recordingTransaction();
  const result = await claimSlackIdentityAttempt(transaction, {
    state: "state-token",
    sessionId: SESSION_ID,
    principalId: PRINCIPAL_ID,
  } as never);
  // No row matches, so it is refused, but only after the one update ran.
  assertEquals(result, { ok: false, reason: "refused" });
  assertEquals(queries.length, 1);
});

// ---- #301: the binding is a session row id, and only its hash is stored.

Deno.test("create refuses a session token where a session id belongs", async () => {
  // A bearer token is not a session row id, so it never reaches the column.
  const { transaction, queries } = recordingTransaction();
  const result = await createSlackIdentityAttempt(
    transaction,
    await createInput(SESSION_TOKEN) as never,
  );
  assertEquals(result, { ok: false, reason: "malformed" });
  assertEquals(queries.length, 0, "the database was touched");
});

Deno.test("claim refuses a session token before the database is touched", async () => {
  const { transaction, queries } = recordingTransaction();
  const result = await claimSlackIdentityAttempt(transaction, {
    state: "state-token",
    sessionId: SESSION_TOKEN,
    principalId: PRINCIPAL_ID,
  } as never);
  assertEquals(result, { ok: false, reason: "refused" });
  assertEquals(queries.length, 0, "the database was touched");
});

Deno.test("the stored session binding is the hash of the session id, never the id itself", async () => {
  const { transaction, params, queries } = recordingTransaction({
    membership: true,
  });
  const created = await createSlackIdentityAttempt(
    transaction,
    await createInput(SESSION_ID) as never,
  );
  assertEquals(created.ok, true, "the create did not write an attempt");
  const index = queries.findIndex((sql) =>
    sql.includes("insert into bakery.slack_identity_attempts")
  );
  assertEquals(index >= 0, true, "the insert never ran");
  const stored = params[index] as readonly unknown[];
  assertEquals(
    stored.includes(SESSION_ID),
    false,
    "the raw session id was stored",
  );
  assertEquals(
    stored.includes(await sha256Hex(SESSION_ID)),
    true,
    "the session binding was not stored as its hash",
  );
});

Deno.test("claim compares the hash of the presented session id", async () => {
  const { transaction, params } = recordingTransaction();
  await claimSlackIdentityAttempt(transaction, {
    state: "state-token",
    sessionId: SESSION_ID,
    principalId: PRINCIPAL_ID,
  } as never);
  const update = params.find((values) => values.includes(PRINCIPAL_ID));
  assertEquals(update !== undefined, true, "the claim never ran");
  const bound = update as readonly unknown[];
  assertEquals(bound.includes(SESSION_ID), false, "the raw id was compared");
  assertEquals(
    bound.includes(await sha256Hex(SESSION_ID)),
    true,
    "the claim did not compare the hash",
  );
});
