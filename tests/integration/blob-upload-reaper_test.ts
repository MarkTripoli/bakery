/**
 * The reaper as the sweeper meets it, against a real database.
 *
 * The properties that matter are not "it deletes rows": they are that it
 * reclaims exactly the sessions whose deadline passed, leaves a session a
 * client can still resume alone, turns a session into a record rather than
 * destroying it, and is safe to run twice. Each of those is a separate case
 * because each fails differently.
 */

import { assertEquals } from "@std/assert";
import {
  BLOB_UPLOAD_REAP_BATCH,
  reapAbandonedBlobUploads,
} from "../../apps/server/src/modules/knowledge/blob-upload-reaper.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

/** A session plus `parts` parts, with its deadline `hours` from now. */
async function seedSession(
  fixture: Fixture,
  options: { hours: number; parts: number; state?: string },
): Promise<string> {
  const session = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.blob_upload_sessions
       (organization_id, created_by_id, sha256, size_bytes, media_type,
        expires_at)
     values ($1, $2, $3, $4, 'text/plain', now() + make_interval(hours => $5))
     returning id`,
    [
      fixture.organizationId,
      fixture.principalId,
      "0".repeat(64),
      11,
      options.hours,
    ],
  );
  const sessionId = session.rows[0].id;
  for (let part = 1; part <= options.parts; part += 1) {
    await fixture.pgDatabase.query(
      `insert into bakery.blob_upload_parts
         (organization_id, session_id, part_number, sha256, size_bytes, content)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        fixture.organizationId,
        sessionId,
        part,
        "0".repeat(64),
        5,
        new Uint8Array([1, 2, 3, 4, 5]),
      ],
    );
  }
  return sessionId;
}

async function partsOf(fixture: Fixture, sessionId: string): Promise<number> {
  const counted = await fixture.pgDatabase.query<{ count: string }>(
    `select count(*)::text as count from bakery.blob_upload_parts
      where organization_id = $1 and session_id = $2`,
    [fixture.organizationId, sessionId],
  );
  return Number(counted.rows[0].count);
}

async function stateOf(fixture: Fixture, sessionId: string): Promise<string> {
  const found = await fixture.pgDatabase.query<{ state: string }>(
    `select state from bakery.blob_upload_sessions
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, sessionId],
  );
  return found.rows[0].state;
}

Deno.test("an expired session loses its parts and keeps its record", async () => {
  await withWorkerFixture(async (fixture) => {
    const expired = await seedSession(fixture, { hours: -1, parts: 3 });

    const result = await reapAbandonedBlobUploads(fixture.pgDatabase);

    assertEquals(result.abandoned, 1);
    assertEquals(result.partsDeleted, 3);
    // The bytes are the storage being reclaimed.
    assertEquals(await partsOf(fixture, expired), 0);
    // The session is a record of what was attempted, so it survives as one.
    assertEquals(await stateOf(fixture, expired), "abandoned");
  });
});

Deno.test("a session a client can still resume is left alone", async () => {
  await withWorkerFixture(async (fixture) => {
    const live = await seedSession(fixture, { hours: 12, parts: 2 });

    const result = await reapAbandonedBlobUploads(fixture.pgDatabase);

    assertEquals(result.abandoned, 0);
    assertEquals(await partsOf(fixture, live), 2);
    assertEquals(await stateOf(fixture, live), "pending");
  });
});

Deno.test("a completed session is not reaped again", async () => {
  await withWorkerFixture(async (fixture) => {
    const completed = await seedSession(fixture, { hours: -1, parts: 0 });
    await fixture.pgDatabase.query(
      `update bakery.blob_upload_sessions set state = 'completed'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, completed],
    );

    const result = await reapAbandonedBlobUploads(fixture.pgDatabase);

    assertEquals(result.abandoned, 0);
    // A completion owns its own cleanup; the reaper must not touch its row.
    assertEquals(await stateOf(fixture, completed), "completed");
  });
});

Deno.test("a second run over the same rows reclaims nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    await seedSession(fixture, { hours: -1, parts: 2 });

    const first = await reapAbandonedBlobUploads(fixture.pgDatabase);
    const second = await reapAbandonedBlobUploads(fixture.pgDatabase);

    assertEquals(first.abandoned, 1);
    // Idempotent: an abandoned session is no longer pending.
    assertEquals(second.abandoned, 0);
    assertEquals(second.partsDeleted, 0);
    assertEquals(second.batches, 0);
  });
});

Deno.test("a batch stops at its limit, and the next run takes the rest", async () => {
  await withWorkerFixture(async (fixture) => {
    for (let index = 0; index < 3; index += 1) {
      await seedSession(fixture, { hours: -1, parts: 1 });
    }

    const first = await reapAbandonedBlobUploads(fixture.pgDatabase, 2, 1);
    assertEquals(first.abandoned, 2);
    assertEquals(first.batches, 1);

    const second = await reapAbandonedBlobUploads(fixture.pgDatabase);
    assertEquals(second.abandoned, 1);
  });
});

Deno.test("the batch size is bounded and the ceilings refuse nonsense", async () => {
  await withWorkerFixture(async (fixture) => {
    // A caller cannot ask for an unbounded run.
    let refused = false;
    try {
      await reapAbandonedBlobUploads(fixture.pgDatabase, 0);
    } catch {
      refused = true;
    }
    assertEquals(refused, true);
    assertEquals(BLOB_UPLOAD_REAP_BATCH, 200);
  });
});
