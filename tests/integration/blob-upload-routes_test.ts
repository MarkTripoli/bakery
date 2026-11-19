/**
 * The upload routes as a client meets them, over HTTP.
 *
 * The tenancy cases prove the functions refuse the wrong caller; this proves the
 * three routes compose into a working upload and that the promises the session
 * makes up front are actually enforced at completion. It is also the only test
 * that exercises route registration, input parsing and response projection
 * together — a handler can be correct and still be wired to the wrong schema.
 */

import { assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { SkillObjectStore } from "../../apps/server/src/modules/catalog/storage-port.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { lockUploadSessionForCompletion } from "../../apps/server/src/modules/knowledge/blobs.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

/**
 * An object store that keeps bytes in memory, so completion has somewhere real
 * to put them.
 *
 * The point of using a store rather than a stub is that the upload path now
 * writes through the shipped adapter, so the assertion that matters is that the
 * bytes the client sent are the bytes under the digest key afterwards.
 */
function memoryStore(): SkillObjectStore & {
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putIfAbsent(objectKey, content, expectedSha256) {
      const digest = await sha256Bytes(content);
      if (digest !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
      }
      if (!objects.has(objectKey)) objects.set(objectKey, content.slice());
    },
    async read(objectKey, expectedSha256, expectedSize) {
      const found = objects.get(objectKey);
      if (!found) throw new Error("SKILL_FILE_NOT_FOUND");
      if (found.byteLength !== expectedSize) {
        throw new Error("SKILL_FILE_SIZE_MISMATCH");
      }
      if (await sha256Bytes(found) !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
      }
      return found;
    },
    async recover(objectKey, expectedSha256, expectedSize) {
      const found = objects.get(objectKey);
      if (!found) throw new Error("SKILL_FILE_NOT_FOUND");
      if (found.byteLength !== expectedSize) {
        throw new Error("SKILL_FILE_SIZE_MISMATCH");
      }
      if (await sha256Bytes(found) !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
      }
    },
    stat(objectKey: string) {
      const found = objects.get(objectKey);
      return Promise.resolve(
        found === undefined ? null : { sizeBytes: found.byteLength },
      );
    },
    delete(objectKey) {
      return Promise.resolve(objects.delete(objectKey));
    },
    async *list() {
      for (const [objectKey, content] of objects) {
        yield {
          objectKey,
          sha256: await sha256Bytes(content),
          sizeBytes: content.byteLength,
        };
      }
    },
  };
}

/** The fixture every case needs: a worker scope plus somewhere to store bytes. */
const withBlobFixture = (
  work: (
    fixture: Fixture,
    store: ReturnType<typeof memoryStore>,
  ) => Promise<void>,
) => {
  const store = memoryStore();
  return withWorkerFixture((fixture) => work(fixture, store), {
    skillFileStore: store,
  });
};

function call(
  fixture: Fixture,
  path: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        // These are commands, so each carries a distinct key: a retry of the
        // same request replays, a new intent does not.
        "Idempotency-Key": crypto.randomUUID(),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  ));
}

Deno.test("a client uploads bytes as parts and completes into a blob", () =>
  withBlobFixture(async (fixture, store) => {
    const first = new TextEncoder().encode("first half ");
    const second = new TextEncoder().encode("second half");
    const whole = new Uint8Array([...first, ...second]);
    const digest = await sha256Bytes(whole);

    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: digest,
        sizeBytes: whole.byteLength,
        mediaType: "text/plain",
      },
    });
    // 201 because it creates a session; a command that creates nothing returns 200.
    assertEquals(startResponse.status, 201, await startResponse.clone().text());
    const session = await startResponse.json();
    assertEquals(session.state, "pending");
    assertEquals(session.partCount, 0);
    assertEquals(session.receivedBytes, 0);

    for (const [index, chunk] of [first, second].entries()) {
      const partResponse = await call(
        fixture,
        `/v1/blobs/uploads/${session.id}/parts/${index + 1}`,
        {
          method: "PUT",
          body: { sha256: await sha256Bytes(chunk), content: base64(chunk) },
        },
      );
      assertEquals(partResponse.status, 200, await partResponse.clone().text());
      const progressed = await partResponse.json();
      assertEquals(progressed.partCount, index + 1);
    }

    const completeResponse = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/complete`,
      { method: "POST", body: {} },
    );
    assertEquals(
      completeResponse.status,
      201,
      await completeResponse.clone().text(),
    );
    const blob = await completeResponse.json();
    assertEquals(blob.sha256, digest);
    assertEquals(blob.sizeBytes, whole.byteLength);
    assertEquals(blob.mediaType, "text/plain");

    // The bytes the client sent are the bytes under the digest key. Before this
    // the completion registered a blob row and wrote nothing anywhere, so the
    // registry named bytes that did not exist.
    const stored = store.objects.get(
      `organizations/${fixture.organizationId}/blobs/sha256/${digest}`,
    );
    assertEquals(stored, whole);

    // The parts are gone: the object store is the home now, and keeping both
    // would store every upload twice, forever.
    const parts = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.blob_upload_parts
        where organization_id = $1 and session_id = $2`,
      [fixture.organizationId, session.id],
    );
    assertEquals(parts.rows[0].count, "0");
  }));

Deno.test("a part whose bytes do not match its digest is refused", () =>
  withBlobFixture(async (fixture) => {
    const bytes = new TextEncoder().encode("payload");
    const digest = await sha256Bytes(bytes);
    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: digest,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain",
      },
    });
    const session = await startResponse.json();

    // The part claims a digest its bytes do not hash to. Storing it would put a
    // corrupt part in the upload and move the failure to completion, where the
    // cause is much harder to find.
    const partResponse = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/parts/1`,
      {
        method: "PUT",
        body: {
          sha256: digest,
          content: base64(new TextEncoder().encode("tampered")),
        },
      },
    );
    // Asserting only the status would accept an anonymous 403 as proof: both are
    // refusals. The code rules out the neighbouring refusals - an auth 403, a
    // lifecycle 409 - so a regression that refuses for the wrong reason cannot
    // pass as this one. The specific reason ("digest_mismatch") is not projected
    // to the client, so the code is the strongest signal the boundary offers;
    // every other input here is valid, which is what makes it attributable.
    assertEquals(partResponse.status, 422);
    const problem = await partResponse.json();
    assertEquals(problem.code, "UNPROCESSABLE");
  }));

Deno.test("retrying the same completion answers the same blob, not a conflict", () =>
  withBlobFixture(async (fixture) => {
    const bytes = new TextEncoder().encode("idempotent");
    const digest = await sha256Bytes(bytes);
    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: digest,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain",
      },
    });
    const session = await startResponse.json();
    await call(fixture, `/v1/blobs/uploads/${session.id}/parts/1`, {
      method: "PUT",
      body: { sha256: digest, content: base64(bytes) },
    });
    const first = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/complete`,
      { method: "POST", body: {} },
    );
    const blob = await first.json();

    // The SAME session, completed again. A client that never saw the first
    // response retries exactly here; a conflict would leave it holding a session
    // it cannot finish and a blob id it cannot learn.
    const retry = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/complete`,
      { method: "POST", body: {} },
    );
    // 201, not 200: the action answers 201 uniformly because the registry owns
    // the status, and the property that matters to a retrying client is that it
    // is not a conflict and it names the same blob.
    assertEquals(retry.status, 201, await retry.clone().text());
    const replay = await retry.json();
    assertEquals(replay.id, blob.id);
    // The timestamp is the row's own, so the retry cannot pass itself off as a
    // newer object.
    assertEquals(replay.createdAt, blob.createdAt);
  }));

Deno.test("parts whose assembled bytes miss the declared digest are refused", () =>
  withBlobFixture(async (fixture) => {
    // The session declares one digest; the parts carry different bytes that each
    // match their own claimed digest. Only assembly reveals the disagreement.
    const declared = new TextEncoder().encode("what the client promised");
    const actual = new TextEncoder().encode("what the client sent!!!");
    const declaredDigest = await sha256Bytes(declared);
    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: declaredDigest,
        // Same length as the bytes actually sent, so only the digest disagrees.
        sizeBytes: actual.byteLength,
        mediaType: "text/plain",
      },
    });
    const session = await startResponse.json();
    const part = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/parts/1`,
      {
        method: "PUT",
        body: { sha256: await sha256Bytes(actual), content: base64(actual) },
      },
    );
    assertEquals(part.status, 200, await part.clone().text());

    const complete = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/complete`,
      { method: "POST", body: {} },
    );
    assertEquals(complete.status, 422, await complete.clone().text());
    const problem = await complete.json();
    assertEquals(problem.code, "UNPROCESSABLE");
  }));

Deno.test("a part that pushes the running total past the declared size is refused", () =>
  withBlobFixture(async (fixture) => {
    // The session declares 13 bytes. A part of 4,096 can never assemble into
    // that, so it is refused at the part rather than stored and discovered at
    // completion - where the client no longer has the bytes in hand.
    //
    // The exemplar that found this was 327,680 bytes, which the request schema
    // refuses before it reaches this check; the bound is what stops a part that
    // is merely large relative to the declaration.
    const declared = new TextEncoder().encode("thirteen byte");
    const oversized = new Uint8Array(4_096);
    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: await sha256Bytes(declared),
        sizeBytes: declared.byteLength,
        mediaType: "text/plain",
      },
    });
    const session = await startResponse.json();

    const part = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/parts/1`,
      {
        method: "PUT",
        body: {
          sha256: await sha256Bytes(oversized),
          content: base64(oversized),
        },
      },
    );
    assertEquals(part.status, 422, await part.clone().text());
    const problem = await part.json();
    assertEquals(problem.code, "UNPROCESSABLE");
  }));

Deno.test("a retried part replaces its own bytes rather than adding to the total", () =>
  withBlobFixture(async (fixture) => {
    // The bound must not count a part against itself, or a client that retries a
    // part it already sent would be refused for exceeding a size it is within.
    const bytes = new TextEncoder().encode("0123456789");
    const digest = await sha256Bytes(bytes);
    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: digest,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain",
      },
    });
    const session = await startResponse.json();
    for (let attempt = 0; attempt < 2; attempt++) {
      const part = await call(
        fixture,
        `/v1/blobs/uploads/${session.id}/parts/1`,
        {
          method: "PUT",
          body: { sha256: digest, content: base64(bytes) },
        },
      );
      assertEquals(part.status, 200, await part.clone().text());
    }
  }));

Deno.test("two sessions for one digest store one blob", () =>
  withBlobFixture(async (fixture) => {
    const bytes = new TextEncoder().encode("same bytes twice");
    const digest = await sha256Bytes(bytes);
    const upload = async () => {
      const started = await call(fixture, "/v1/blobs/uploads", {
        method: "POST",
        body: {
          sha256: digest,
          sizeBytes: bytes.byteLength,
          mediaType: "text/plain",
        },
      });
      const session = await started.json();
      await call(fixture, `/v1/blobs/uploads/${session.id}/parts/1`, {
        method: "PUT",
        body: { sha256: digest, content: base64(bytes) },
      });
      const completed = await call(
        fixture,
        `/v1/blobs/uploads/${session.id}/complete`,
        { method: "POST", body: {} },
      );
      return await completed.json();
    };

    const first = await upload();
    const second = await upload();
    assertEquals(second.id, first.id);
    assertEquals(second.createdAt, first.createdAt);
  }));

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * One reaper pass, shaped exactly like the sweep that ships separately.
 *
 * It takes the session row `for update skip locked` before touching anything,
 * because that is the whole defence: the completion's lock is on the session,
 * not on the parts, so a delete that does not take the same lock can interleave
 * with a completion that is holding it perfectly correctly. Returns whether it
 * won the session.
 */
async function reapOnce(
  fixture: Fixture,
  sessionId: string,
): Promise<boolean> {
  return await withPgTransaction(fixture.pgDatabase, async (tx) => {
    const locked = await tx.query<{ id: string }>(
      `select id from bakery.blob_upload_sessions
        where organization_id = $1 and id = $2
          and state = 'pending' and expires_at <= now()
        for update skip locked`,
      [fixture.organizationId, sessionId],
    );
    if (locked.rows.length === 0) return false;
    await tx.query(
      `delete from bakery.blob_upload_parts
        where organization_id = $1 and session_id = $2`,
      [fixture.organizationId, sessionId],
    );
    await tx.query(
      `update bakery.blob_upload_sessions
          set state = 'expired', updated_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, sessionId],
    );
    return true;
  });
}

/** A session with two parts, its deadline `offsetMs` from now. */
async function seedUpload(
  fixture: Fixture,
  offsetMs: number,
): Promise<{ sessionId: string; digest: string; whole: Uint8Array }> {
  const chunks = [
    new TextEncoder().encode("first half "),
    new TextEncoder().encode("second half"),
  ];
  const whole = new Uint8Array([...chunks[0], ...chunks[1]]);
  const digest = await sha256Bytes(whole);
  const created = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.blob_upload_sessions
       (organization_id, created_by_id, sha256, size_bytes, media_type,
        expires_at)
     values ($1, $2, $3, $4, 'text/plain', now() + make_interval(secs => $5))
     returning id`,
    [
      fixture.organizationId,
      fixture.principalId,
      digest,
      whole.byteLength,
      offsetMs / 1000,
    ],
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
  return { sessionId, digest, whole };
}

Deno.test("a retry after the window closed still answers with the blob", () =>
  withBlobFixture(async (fixture) => {
    // Completion is idempotent and the blob is immutable, so expiry bounds the
    // upload, not the reading back of a finished result. The old guard refused
    // this on `expiresAt <= now` without asking whether anything was left to
    // accept, which made the retry branch unreachable.
    const { sessionId, digest } = await seedUpload(fixture, 60_000);
    const first = await call(
      fixture,
      `/v1/blobs/uploads/${sessionId}/complete`,
      { method: "POST", body: {} },
    );
    assertEquals(first.status, 201, await first.clone().text());
    const firstBlob = await first.json();

    // Close the window behind a finished upload.
    await fixture.pgDatabase.query(
      `update bakery.blob_upload_sessions
          set expires_at = now() - interval '1 hour'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, sessionId],
    );

    const retry = await call(
      fixture,
      `/v1/blobs/uploads/${sessionId}/complete`,
      { method: "POST", body: {} },
    );
    assertEquals(retry.status, 201, await retry.clone().text());
    const retried = await retry.json();
    assertEquals(retried.id, firstBlob.id);
    assertEquals(retried.sha256, digest);
  }));

Deno.test("a reaper skips a session a completion is holding", () =>
  withBlobFixture(async (fixture) => {
    // The completion's lock is on the session row, not on the parts, so the
    // defence is that the reaper takes the same lock. The window has to close
    // on COMMITTED data while the completion is inside its transaction, which
    // is what time does: the completion passes its guard on a live session and
    // the deadline passes while it is still working. An expiry written inside
    // the completion's own transaction would not be visible to the reaper at
    // all, and the test would pass without exercising the lock.
    const { sessionId } = await seedUpload(fixture, 2_000);

    await withPgTransaction(fixture.pgDatabase, async (tx) => {
      await lockUploadSessionForCompletion(tx, {
        organizationId: fixture.organizationId,
        principalId: fixture.principalId,
        sessionId,
      });
      // The deadline passes while the completion holds the row.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      // Without `skip locked` the reaper blocks here until this transaction
      // ends; the red-proof for this test removes it and observes that.
      assertEquals(await reapOnce(fixture, sessionId), false);
      const parts = await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.blob_upload_parts
          where organization_id = $1 and session_id = $2`,
        [fixture.organizationId, sessionId],
      );
      assertEquals(parts.rows[0].count, "2");
    });

    // Once the lock is released the session is reapable again.
    assertEquals(await reapOnce(fixture, sessionId), true);
  }));

Deno.test("a completion racing a reaper never corrupts a legitimate upload", () =>
  withBlobFixture(async (fixture) => {
    // Ten rounds. The only outcomes allowed are a full success or a typed
    // refusal: a size or digest mismatch is the signature of the reaper
    // deleting parts between the read and the assembly, and it is the one
    // outcome a client reads as data corruption.
    for (let round = 0; round < 10; round += 1) {
      const { sessionId } = await seedUpload(fixture, 0);
      const [completion, reaping] = await Promise.allSettled([
        call(fixture, `/v1/blobs/uploads/${sessionId}/complete`, {
          method: "POST",
          body: {},
        }),
        reapOnce(fixture, sessionId),
      ]);
      void reaping;
      if (completion.status === "rejected") throw completion.reason;
      const response = completion.value;
      if (response.status !== 201) {
        const problem = await response.json();
        // A refusal is fine; a mismatch is not. The mismatch codes are
        // UNPROCESSABLE, so anything else here is the race being refused
        // cleanly rather than the upload being reported as corrupt.
        assertEquals(
          problem.code === "STATE_CONFLICT" ||
            problem.code === "RESOURCE_NOT_FOUND",
          true,
          `unexpected refusal ${JSON.stringify(problem)}`,
        );
      }
      const state = await fixture.pgDatabase.query<{ state: string }>(
        `select state from bakery.blob_upload_sessions
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, sessionId],
      );
      assertEquals(
        state.rows[0].state === "completed" ||
          state.rows[0].state === "expired",
        true,
      );
    }
  }));
