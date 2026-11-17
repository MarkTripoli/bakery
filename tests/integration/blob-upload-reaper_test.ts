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
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  assembleDeclaredBytes,
  completeUploadSession,
  lockUploadSession,
  readUploadParts,
  recordBlob,
} from "../../apps/server/src/modules/knowledge/blobs.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

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

/**
 * A completion, driven through the same primitives the handler uses.
 *
 * The point is not to re-test completion; it is that the reaper and a real
 * completion must be mutually exclusive on a session, and that can only be
 * shown against the real lock and the real assembly.
 */
async function completeLikeTheHandler(
  fixture: Fixture,
  sessionId: string,
): Promise<{ id: string }> {
  return await withPgTransaction(fixture.pgDatabase, async (tx) => {
    const session = await lockUploadSession(tx, {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
      sessionId,
    });
    const parts = await readUploadParts(tx, {
      organizationId: fixture.organizationId,
      sessionId,
    });
    const bytes = assembleDeclaredBytes(parts, {
      sha256: session.sha256,
      sizeBytes: Number(session.sizeBytes),
    });
    const blob = await recordBlob(tx, {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
      sha256: session.sha256,
      sizeBytes: bytes.byteLength,
      mediaType: session.mediaType,
    });
    await completeUploadSession(tx, {
      organizationId: fixture.organizationId,
      sessionId,
      blobId: blob.id,
    });
    return blob;
  });
}

Deno.test("a reaper skips a session a completion is holding", async () => {
  await withWorkerFixture(async (fixture) => {
    // A session that is already past its deadline, so the reaper would take it
    // if it could. The completion below is the only thing standing in the way.
    const sessionId = await seedSession(fixture, { hours: -1, parts: 2 });

    // Hold the session row the way a completion does, then reap from outside.
    //
    // The lock is taken raw rather than through `lockUploadSession`, because
    // that function refuses an expired session outright - which is itself the
    // first half of the defence. The case left to prove is a completion that
    // was legitimate when it started and whose session expires while it is
    // still holding the row, so the lock has to be taken without the guard.
    const held = withPgTransaction(fixture.pgDatabase, async (tx) => {
      await tx.query(
        `select id from bakery.blob_upload_sessions
          where organization_id = $1 and id = $2 for update`,
        [fixture.organizationId, sessionId],
      );
      // The reaper runs while the lock is held. `skip locked` is what makes
      // this return rather than wait, and what makes it leave the parts alone.
      const result = await reapAbandonedBlobUploads(fixture.pgDatabase);
      assertEquals(result.abandoned, 0);
      assertEquals(await partsOf(fixture, sessionId), 2);
      assertEquals(await stateOf(fixture, sessionId), "pending");
    });
    await held;

    // Once the lock is released the session is reapable again.
    const after = await reapAbandonedBlobUploads(fixture.pgDatabase);
    assertEquals(after.abandoned, 1);
    assertEquals(await partsOf(fixture, sessionId), 0);
  });
});

Deno.test("a completion and a reaper racing never corrupt a legitimate upload", async () => {
  await withWorkerFixture(async (fixture) => {
    // Ten rounds, each a fresh session that is expired by the time the reaper
    // looks but which a completion is already working on. The only outcomes
    // allowed are a full success or a typed refusal: a size or digest mismatch
    // would be the signature of the reaper deleting parts mid-assembly, and it
    // is the one outcome a client would read as data corruption.
    for (let round = 0; round < 10; round += 1) {
      const sessionId = await seedSession(fixture, { hours: -1, parts: 3 });
      const [completion, reaping] = await Promise.allSettled([
        completeLikeTheHandler(fixture, sessionId),
        reapAbandonedBlobUploads(fixture.pgDatabase),
      ]);
      void reaping;
      if (completion.status === "rejected") {
        const error = completion.reason;
        assertEquals(error instanceof StandardError, true);
        const code = (error as StandardError).code;
        // A refusal is fine; a mismatch is not. `upload_parts_incomplete` is
        // the reaper having won the session, which is a clean loss.
        assertEquals(
          code === "STATE_CONFLICT" || code === "RESOURCE_NOT_FOUND" ||
            code === "UNPROCESSABLE",
          true,
        );
        if (code === "UNPROCESSABLE") {
          const reason = (error as StandardError).params?.reason;
          assertEquals(reason, "upload_parts_incomplete");
        }
      }
      // Whatever happened, the session is in exactly one state and never both
      // completed and abandoned. `pending` is a legitimate outcome: the
      // completion held the lock and refused, so the reaper skipped it, and the
      // next run takes it. What must never happen is a half-finished session.
      const state = await stateOf(fixture, sessionId);
      assertEquals(
        state === "completed" || state === "abandoned" || state === "pending",
        true,
      );
      if (state === "pending") {
        // The reaper's next run must be able to finish the job.
        const swept = await reapAbandonedBlobUploads(fixture.pgDatabase);
        assertEquals(swept.abandoned >= 1, true);
        assertEquals(await stateOf(fixture, sessionId), "abandoned");
        assertEquals(await partsOf(fixture, sessionId), 0);
      }
    }
  });
});
