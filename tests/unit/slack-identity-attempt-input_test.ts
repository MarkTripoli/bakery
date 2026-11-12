import { assertEquals } from "@std/assert";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import {
  claimSlackIdentityAttempt,
  createSlackIdentityAttempt,
} from "../../apps/server/src/modules/integrations/slack-identity-attempts.ts";

// Input that is wrong is refused before the database is touched. A NUL byte in
// the session id used to get past the checks and surface as a database error
// ("invalid byte sequence for encoding UTF8: 0x00") that aborts the caller's
// transaction; it is now a refusal. The id comes from the server session, so
// this is a guard on the module's own contract, not a reachable attack.

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000002";

/** A transaction that records what it is asked and answers every query with no rows. */
function recordingTransaction() {
  const queries: string[] = [];
  const transaction = {
    query: (sql: string) => {
      queries.push(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as PgTransactionClient;
  return { transaction, queries };
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
    await createInput("session-0123456789abcdef") as never,
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
    sessionId: "session-0123456789abcdef",
    principalId: PRINCIPAL_ID,
  } as never);
  // No row matches, so it is refused, but only after the one update ran.
  assertEquals(result, { ok: false, reason: "refused" });
  assertEquals(queries.length, 1);
});
