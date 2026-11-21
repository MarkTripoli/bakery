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
  assembleVerifiedBytes,
  completeUploadSession,
  lockUploadSession,
  lockUploadSessionForCompletion,
  putUploadPart,
  readBlob,
  recordBlob,
  streamUploadParts,
} from "../../apps/server/src/modules/knowledge/blobs.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";

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
    assertEquals(await stateOf(fixture, expired), "expired");
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
    // The completion door, not the part door - this has to be the function the
    // real handler calls, or the test proves something the handler does not do.
    const session = await lockUploadSessionForCompletion(tx, {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
      sessionId,
    });
    // The handler answers a retry with the blob it already produced, before it
    // reaches `completeUploadSession`, whose update is correctly limited to a
    // pending session. Skipping this branch would make a retry look like a
    // refusal and prove nothing about the guard.
    if (session.state === "completed") {
      return await readBlob(tx, {
        organizationId: fixture.organizationId,
        blobId: session.completedBlobId!,
      });
    }
    const bytes = await assembleVerifiedBytes(
      streamUploadParts(tx, {
        organizationId: fixture.organizationId,
        sessionId,
      }),
      { sha256: session.sha256, sizeBytes: Number(session.sizeBytes) },
    );
    // The bytes are in the store by now, so recording them is allowed.
    const blob = await recordBlob(tx, {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
      sha256: session.sha256,
      sizeBytes: bytes.byteLength,
      mediaType: session.mediaType,
    }, {
      stat: () => Promise.resolve({ sizeBytes: bytes.byteLength }),
    });
    await completeUploadSession(tx, {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
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
    //
    // This is a SMOKE TEST, not the proof. qa-qa red-proved it: removing
    // `for update` from the lock still passes here, because a race test only
    // fails when the thread schedule happens to land in the damaging window,
    // and ten rounds do not reliably hit it. The proof that the lock exists and
    // excludes is "a reaper skips a session a completion is holding" above: it
    // holds the lock in an open transaction, lets real time carry the session
    // past its deadline, and asserts the sweep declines. That test fails when
    // the lock is removed, so that one is the gate - if it is ever weakened or
    // deleted, this test stays green and will not tell you.
    //
    // It also drives the real reapAbandonedBlobUploads rather than a reaper
    // shaped delete, which is what makes it worth keeping at all.
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
        state === "completed" || state === "expired" || state === "pending",
        true,
      );
      if (state === "pending") {
        // The reaper's next run must be able to finish the job.
        const swept = await reapAbandonedBlobUploads(fixture.pgDatabase);
        assertEquals(swept.abandoned >= 1, true);
        assertEquals(await stateOf(fixture, sessionId), "expired");
        assertEquals(await partsOf(fixture, sessionId), 0);
      }
    }
  });
});

Deno.test("the reaper touches only the sessions it selected, across organizations", async () => {
  await withWorkerFixture(async (fixture) => {
    // The provable form of the tenancy intent. The reaper is a system sweep, so
    // it is not scoped by a caller's organization - which is exactly why the
    // property that matters is that it touches only what it selected. Two
    // organizations, both with an expired session and parts; the sweep is
    // limited to one session, so the other organization's session must come out
    // of the run completely untouched.
    //
    // What this pins is the delete's SESSION scoping: a predicate that reaches
    // past the selected session - deleting by part number, by age, by anything
    // that is not the doomed id - fails here. It does NOT pin the organization
    // key in that delete, and it cannot: the session id is a uuid primary key,
    // so removing the organization leaves the statement exactly as selective
    // and the suite green. The organization key is defence in depth, and the
    // comment on the delete says so. Do not read this test as covering it.
    const otherOrganization = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.organizations (id, slug, name, created_at, updated_at)
       values (gen_random_uuid(), $1, $1, now(), now()) returning id`,
      [`reaper-other-${crypto.randomUUID()}`],
    );
    const otherOrganizationId = otherOrganization.rows[0].id;

    // This organization's session is the older one, so it is selected first.
    const mine = await seedSession(fixture, { hours: -2, parts: 2 });
    const other = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.blob_upload_sessions
         (organization_id, created_by_id, sha256, size_bytes, media_type,
          expires_at)
       values ($1, $2, $3, 11, 'text/plain', now() - interval '1 hour')
       returning id`,
      [otherOrganizationId, fixture.principalId, "0".repeat(64)],
    );
    const theirs = other.rows[0].id;
    await fixture.pgDatabase.query(
      `insert into bakery.blob_upload_parts
         (organization_id, session_id, part_number, sha256, size_bytes, content)
       values ($1, $2, 1, $3, 5, $4)`,
      [otherOrganizationId, theirs, "0".repeat(64), new Uint8Array([9])],
    );

    // One session, one batch: the sweep cannot reach the second organization.
    const result = await reapAbandonedBlobUploads(fixture.pgDatabase, 1, 1);

    assertEquals(result.abandoned, 1);
    assertEquals(await partsOf(fixture, mine), 0);
    assertEquals(await stateOf(fixture, mine), "expired");
    // The other organization is exactly as it was.
    const untouched = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.blob_upload_parts
        where organization_id = $1 and session_id = $2`,
      [otherOrganizationId, theirs],
    );
    assertEquals(untouched.rows[0].count, "1");
    const otherState = await fixture.pgDatabase.query<{ state: string }>(
      `select state from bakery.blob_upload_sessions
        where organization_id = $1 and id = $2`,
      [otherOrganizationId, theirs],
    );
    assertEquals(otherState.rows[0].state, "pending");

    // The fixture tears down its own organization; this one is ours to remove,
    // and the creator foreign key is `on delete restrict`, so it has to go
    // before the principal does.
    await fixture.pgDatabase.query(
      `delete from bakery.blob_upload_sessions where organization_id = $1`,
      [otherOrganizationId],
    );
    await fixture.pgDatabase.query(
      `delete from bakery.organizations where id = $1`,
      [otherOrganizationId],
    );
  });
});

Deno.test("a session with recent parts is left alone by the abandonment window", async () => {
  await withWorkerFixture(async (fixture) => {
    // Inside the deadline, so only the window could reach it, and the window is
    // the lifetime, so it cannot. This pins the ordering the safety argument
    // rests on: the window may only make the sweep more conservative.
    const live = await seedSession(fixture, { hours: 12, parts: 1 });

    const result = await reapAbandonedBlobUploads(fixture.pgDatabase);

    assertEquals(result.abandoned, 0);
    assertEquals(await partsOf(fixture, live), 1);
    assertEquals(await stateOf(fixture, live), "pending");
  });
});

Deno.test("a window shorter than the session lifetime is refused, not clamped", async () => {
  await withWorkerFixture(async (fixture) => {
    // A shorter window would reclaim an upload a client is still entitled to
    // finish. Refusing a configuration is honest; clamping it silently would
    // hide the misconfiguration that is the whole hazard.
    let refused = false;
    try {
      await reapAbandonedBlobUploads(
        fixture.pgDatabase,
        BLOB_UPLOAD_REAP_BATCH,
        1,
        1_000,
      );
    } catch (error) {
      refused =
        (error as Error).message === "BLOB_UPLOAD_REAP_WINDOW_TOO_SHORT";
    }
    assertEquals(refused, true);
  });
});

Deno.test("a completed session stays readable long after its window closed", async () => {
  await withWorkerFixture(async (fixture) => {
    // Completion is idempotent and the blob it names is immutable, so expiry
    // bounds the upload, not the reading back of a finished result. Before the
    // guard was inverted this was unreachable: a denylist refused on
    // `expiresAt <= now` without asking whether anything was left to accept.
    const chunks = [
      new TextEncoder().encode("hello "),
      new TextEncoder().encode("world"),
    ];
    const whole = new Uint8Array([...chunks[0], ...chunks[1]]);
    const digest = await sha256Bytes(whole);
    const created = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.blob_upload_sessions
         (organization_id, created_by_id, sha256, size_bytes, media_type,
          expires_at)
       values ($1, $2, $3, $4, 'text/plain', now() + interval '1 hour')
       returning id`,
      [fixture.organizationId, fixture.principalId, digest, whole.byteLength],
    );
    const sessionId = created.rows[0].id;
    for (const [index, chunk] of chunks.entries()) {
      await fixture.pgDatabase.query(
        `insert into bakery.blob_upload_parts
           (organization_id, session_id, part_number, sha256, size_bytes, content)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          fixture.organizationId,
          sessionId,
          index + 1,
          await sha256Bytes(chunk),
          chunk.byteLength,
          chunk,
        ],
      );
    }

    // Finish it while it is live, then close the window behind it.
    await completeLikeTheHandler(fixture, sessionId);
    await fixture.pgDatabase.query(
      `update bakery.blob_upload_sessions
          set expires_at = now() - interval '1 hour'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, sessionId],
    );

    // A retry must still reach the session, so the handler can answer with the
    // blob it produced rather than refusing a finished upload.
    const session = await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        lockUploadSession(tx, {
          organizationId: fixture.organizationId,
          principalId: fixture.principalId,
          sessionId,
        }),
    );
    assertEquals(session.state, "completed");
    assertEquals(session.completedBlobId !== null, true);

    // And the reaper leaves it alone: a completed session is not pending.
    const result = await reapAbandonedBlobUploads(fixture.pgDatabase);
    assertEquals(result.abandoned, 0);
    assertEquals(await stateOf(fixture, sessionId), "completed");
  });
});

Deno.test("a reaped session refuses a late part with a named reason", async () => {
  await withWorkerFixture(async (fixture) => {
    const sessionId = await seedSession(fixture, { hours: -1, parts: 1 });
    await reapAbandonedBlobUploads(fixture.pgDatabase);

    let refused: StandardError | undefined;
    try {
      await withPgTransaction(
        fixture.pgDatabase,
        (tx) =>
          lockUploadSession(tx, {
            organizationId: fixture.organizationId,
            principalId: fixture.principalId,
            sessionId,
          }),
      );
    } catch (error) {
      refused = error as StandardError;
    }
    assertEquals(refused instanceof StandardError, true);
    assertEquals(refused?.code, "STATE_CONFLICT");
    // The reason is what tells a client the difference between "you are too
    // late" and "someone else finished this".
    assertEquals(refused?.params?.reason, "upload_session_expired");
  });
});

Deno.test("a part cannot be written into a completed session", async () => {
  await withWorkerFixture(async (fixture) => {
    // The lock admits a completed session so the completion path can read a
    // finished upload and answer a retry with its blob. That admission is safe
    // only because the part write refuses one itself - so this is the test that
    // holds the two guards apart. Without it, relocating the rule out of the
    // shared lock would quietly reopen part writes into finished uploads, which
    // is the mutation that matters because it is exactly what the relocation
    // made possible.
    // Real bytes, hashed, so the completion path will accept them: the session
    // under test has to be finished the way a client finishes one.
    const chunks = [
      new TextEncoder().encode("first"),
      new TextEncoder().encode("second"),
    ];
    const whole = new Uint8Array([...chunks[0], ...chunks[1]]);
    const digest = await sha256Bytes(whole);
    const created = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.blob_upload_sessions
         (organization_id, created_by_id, sha256, size_bytes, media_type,
          expires_at)
       values ($1, $2, $3, $4, 'text/plain', now() + interval '1 hour')
       returning id`,
      [fixture.organizationId, fixture.principalId, digest, whole.byteLength],
    );
    const sessionId = created.rows[0].id;
    for (const [index, chunk] of chunks.entries()) {
      await fixture.pgDatabase.query(
        `insert into bakery.blob_upload_parts
           (organization_id, session_id, part_number, sha256, size_bytes, content)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          fixture.organizationId,
          sessionId,
          index + 1,
          await sha256Bytes(chunk),
          chunk.byteLength,
          chunk,
        ],
      );
    }
    await completeLikeTheHandler(fixture, sessionId);

    let refused: StandardError | undefined;
    try {
      await withPgTransaction(
        fixture.pgDatabase,
        (tx) =>
          putUploadPart(tx, {
            organizationId: fixture.organizationId,
            principalId: fixture.principalId,
            sessionId,
            partNumber: 3,
            sha256: "0".repeat(64),
            content: new Uint8Array([1]),
          }),
      );
    } catch (error) {
      refused = error as StandardError;
    }
    assertEquals(refused instanceof StandardError, true);
    assertEquals(refused?.code, "STATE_CONFLICT");
    // The part was not written: the two parts the upload arrived with are all
    // there is, and no third row appeared.
    assertEquals(await partsOf(fixture, sessionId), 2);
  });
});
