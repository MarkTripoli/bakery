/**
 * #415: a Slack retry, and a person pressing Approve twice, are the same request.
 *
 * Real database, real unique index. Verification cannot tell a retry from a first
 * delivery -- the signature is identical by construction -- so the only thing that
 * separates them is whether a receipt already exists. That makes the insertion the
 * test subject rather than the module around it: the second copy must arrive as
 * `duplicate`, name the first copy's receipt, and leave exactly one row.
 */
import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  claimSlackRequest,
  purgeSlackRequestReceipts,
  SLACK_RECEIPT_RETENTION_SECONDS,
} from "../../apps/server/src/modules/integrations/slack-request-receipts.ts";

const KEY = "a".repeat(64);
const DIGEST = "b".repeat(64);
const OTHER_KEY = "c".repeat(64);
const FRESH_KEY = "e".repeat(64);

/** This file's keys only: receipts are global, so a re-run must not inherit them. */
async function clearOwnReceipts(
  database: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
): Promise<void> {
  await database.query(
    "delete from bakery.slack_request_receipts where replay_key = any($1)",
    [[KEY, OTHER_KEY, FRESH_KEY]],
  );
}

Deno.test("a replayed signed request is a duplicate of the first, not a second effect", async () => {
  await withWorkerFixture(async (fixture) => {
    await clearOwnReceipts(fixture.pgDatabase);
    const first = await claimSlackRequest(fixture.pgDatabase, {
      replayKey: KEY,
      bodyDigest: DIGEST,
      requestedAt: 1_760_000_000,
      teamId: "T024BE7LD",
    });
    assertEquals(first.disposition, "accepted");

    const replay = await claimSlackRequest(fixture.pgDatabase, {
      replayKey: KEY,
      bodyDigest: DIGEST,
      requestedAt: 1_760_000_000,
      teamId: "T024BE7LD",
    });
    // The same receipt id: a caller answering the retry can name what it already
    // answered, rather than reporting a fresh acceptance.
    assertEquals(replay.disposition, "duplicate");
    assertEquals(replay.receiptId, first.receiptId);

    const { rows } = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.slack_request_receipts
        where replay_key = $1`,
      [KEY],
    );
    assertEquals(rows[0]?.count, "1");

    // A different body -- the same person pressing Reject afterwards -- is its own
    // request: the key is the signature, and the signature covers the body.
    const other = await claimSlackRequest(fixture.pgDatabase, {
      replayKey: OTHER_KEY,
      bodyDigest: "d".repeat(64),
      requestedAt: 1_760_000_001,
      teamId: "T024BE7LD",
    });
    assertEquals(other.disposition, "accepted");
    assert(other.receiptId !== first.receiptId);
  });
});

Deno.test("two copies that arrive together still make one receipt", async () => {
  await withWorkerFixture(async (fixture) => {
    await clearOwnReceipts(fixture.pgDatabase);
    // The module's promise is that the unique index decides, not a read before
    // the write: two workers can both find no receipt and both insert. Without
    // the conflict clause the loser raises a unique violation instead of
    // reporting the duplicate it is.
    const claims = await Promise.all([
      claimSlackRequest(fixture.pgDatabase, {
        replayKey: FRESH_KEY,
        bodyDigest: "f".repeat(64),
        requestedAt: 1_760_000_100,
        teamId: null,
      }),
      claimSlackRequest(fixture.pgDatabase, {
        replayKey: FRESH_KEY,
        bodyDigest: "f".repeat(64),
        requestedAt: 1_760_000_100,
        teamId: null,
      }),
    ]);
    const dispositions = claims.map((claim) => claim.disposition).sort();
    assertEquals(dispositions, ["accepted", "duplicate"]);
    assertEquals(claims[0]?.receiptId, claims[1]?.receiptId);
    const { rows } = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.slack_request_receipts
        where replay_key = $1`,
      [FRESH_KEY],
    );
    assertEquals(rows[0]?.count, "1");
  });
});

Deno.test("the table refuses a key that is not a signature", async () => {
  await withWorkerFixture(async (fixture) => {
    // The receipt is only meaningful if the key really is the MAC output; a
    // truncated or uppercased copy would silently fail to collide with a replay of
    // the real thing.
    const errors: string[] = [];
    for (
      const replayKey of [
        "A".repeat(64),
        "a".repeat(63),
        `v0=${"a".repeat(64)}`,
      ]
    ) {
      try {
        await claimSlackRequest(fixture.pgDatabase, {
          replayKey,
          bodyDigest: DIGEST,
          requestedAt: 1_760_000_000,
          teamId: null,
        });
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    assertEquals(errors.length, 3);
    const { rows } = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.slack_request_receipts
        where body_digest = $1 and replay_key <> $2`,
      [DIGEST, KEY],
    );
    assertEquals(rows[0]?.count, "0");
  });
});

Deno.test("a receipt is purged once it is older than the window, and a fresh one survives", async () => {
  await withWorkerFixture(async (fixture) => {
    await clearOwnReceipts(fixture.pgDatabase);
    await claimSlackRequest(fixture.pgDatabase, {
      replayKey: KEY,
      bodyDigest: DIGEST,
      requestedAt: 1_760_000_000,
      teamId: null,
    });
    await fixture.pgDatabase.query(
      `update bakery.slack_request_receipts
          set received_at = now() - make_interval(secs => $1)`,
      [SLACK_RECEIPT_RETENTION_SECONDS + 60],
    );
    const fresh = await claimSlackRequest(fixture.pgDatabase, {
      replayKey: FRESH_KEY,
      bodyDigest: DIGEST,
      requestedAt: 1_760_000_000,
      teamId: null,
    });
    assertEquals(fresh.disposition, "accepted");

    assertEquals(await purgeSlackRequestReceipts(fixture.pgDatabase), 1);
    // Scoped to this test's two keys: the other tests share the database.
    const { rows } = await fixture.pgDatabase.query<{ replay_key: string }>(
      `select replay_key from bakery.slack_request_receipts
        where replay_key in ($1, $2)
        order by replay_key`,
      [KEY, FRESH_KEY],
    );
    assertEquals(rows.map((row) => row.replay_key), [FRESH_KEY]);
    // A second sweep is a no-op rather than a failure.
    assertEquals(await purgeSlackRequestReceipts(fixture.pgDatabase), 0);
  });
});
