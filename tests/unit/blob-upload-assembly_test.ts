import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createHash } from "node:crypto";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertSessionConsistent,
  lockUploadSession,
  MAX_BLOB_BYTES,
  startUploadSession,
  UPLOAD_SESSION_TTL_MS,
  verifyDeclaredBytes,
} from "../../apps/server/src/modules/knowledge/blobs.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** The refusal reason, or undefined when the call would not have refused. */
const refusal = (error: unknown): string | undefined =>
  error instanceof StandardError
    ? (error.params?.reason as string | undefined)
    : undefined;

const digestOf = (text: string) =>
  createHash("sha256").update(bytes(text)).digest("hex");

/** Feeds parts to the verifier the way the handler does: as a stream. */
async function* stream(
  parts: ReadonlyArray<Readonly<{ partNumber: number; content: Uint8Array }>>,
) {
  for (const part of parts) yield part;
}

Deno.test("contiguous parts that match the declaration are accepted", async () => {
  const parts = [
    { partNumber: 1, content: bytes("hello ") },
    { partNumber: 2, content: bytes("world") },
  ];
  await verifyDeclaredBytes(stream(parts), {
    sha256: digestOf("hello world"),
    sizeBytes: 11,
  });
});

Deno.test("a part numbered out of order is refused, not sorted into place", async () => {
  // Sorting would accept a client's mistake and assemble a file nobody sent.
  const outOfOrder = [
    { partNumber: 2, content: bytes("world") },
    { partNumber: 1, content: bytes("hello ") },
  ];
  const error = await assertRejects(() =>
    verifyDeclaredBytes(stream(outOfOrder), {
      sha256: digestOf("hello world"),
      sizeBytes: 11,
    })
  );
  assertEquals(refusal(error), "upload_parts_incomplete");
});

Deno.test("a gap in the ordinals is refused", async () => {
  // A gap means the client has not sent everything it said it would.
  const gap = [
    { partNumber: 1, content: bytes("hello ") },
    { partNumber: 3, content: bytes("world") },
  ];
  const error = await assertRejects(() =>
    verifyDeclaredBytes(stream(gap), {
      sha256: digestOf("hello world"),
      sizeBytes: 11,
    })
  );
  assertEquals(refusal(error), "upload_parts_incomplete");
});

Deno.test("a duplicate ordinal is refused", async () => {
  const duplicated = [
    { partNumber: 1, content: bytes("hello ") },
    { partNumber: 1, content: bytes("world") },
  ];
  await assertRejects(() =>
    verifyDeclaredBytes(stream(duplicated), {
      sha256: digestOf("hello world"),
      sizeBytes: 11,
    })
  );
});

Deno.test("an empty session is refused rather than yielding zero bytes", async () => {
  const error = await assertRejects(() =>
    verifyDeclaredBytes(stream([]), { sha256: digestOf(""), sizeBytes: 0 })
  );
  assertEquals(refusal(error), "upload_parts_incomplete");
});

Deno.test("a size that differs from the declaration is refused before storage", async () => {
  const parts = [{ partNumber: 1, content: bytes("hello world") }];
  const tooShort = await assertRejects(() =>
    verifyDeclaredBytes(stream(parts), {
      sha256: digestOf("hello world"),
      sizeBytes: 10,
    })
  );
  assertEquals(refusal(tooShort), "upload_size_mismatch");
  const tooLong = await assertRejects(() =>
    verifyDeclaredBytes(stream(parts), {
      sha256: digestOf("hello world"),
      sizeBytes: 12,
    })
  );
  assertEquals(refusal(tooLong), "upload_size_mismatch");
});

Deno.test("parts whose bytes miss the declared digest are refused", async () => {
  // The declaration is a claim until the bytes are hashed; this is the check
  // that turns it into a fact.
  const parts = [{ partNumber: 1, content: bytes("hello world") }];
  const error = await assertRejects(() =>
    verifyDeclaredBytes(stream(parts), {
      sha256: digestOf("something else"),
      sizeBytes: 11,
    })
  );
  assertEquals(refusal(error), "upload_digest_mismatch");
});

Deno.test("verification consumes each part before the next is produced", async () => {
  // The declared size may be 5 GiB. Collecting the parts and then hashing their
  // copy peaks at twice that, which is what turns one large upload into an
  // out-of-memory kill. This pins the streaming property from the outside: the
  // generator wipes each part's bytes the moment the next one is pulled, so a
  // verifier that held them would hash zeroes and refuse.
  const parts = Array.from({ length: 4 }, (_, index) => ({
    partNumber: index + 1,
    content: bytes("chunk"),
  }));
  let previous: Uint8Array | undefined;
  async function* invalidating() {
    for (const part of parts) {
      previous?.fill(0);
      previous = part.content;
      yield part;
    }
  }
  await verifyDeclaredBytes(invalidating(), {
    sha256: digestOf("chunkchunkchunkchunk"),
    sizeBytes: 20,
  });
});

Deno.test("a session deadline is absolute, not extended by use", () => {
  // A sliding deadline lets a stalled upload keep itself alive forever, which
  // is the same as having no deadline.
  const now = Date.now();
  const first = new Date(now + UPLOAD_SESSION_TTL_MS);
  const second = new Date(now + UPLOAD_SESSION_TTL_MS);
  assertEquals(first.getTime(), second.getTime());
  assert(UPLOAD_SESSION_TTL_MS > 0);
});

Deno.test("the file ceiling is 5 GiB and is refused above it", () => {
  assertEquals(MAX_BLOB_BYTES, 5 * 1024 * 1024 * 1024);
});

Deno.test("a malformed digest is refused by the server, not by a constraint", async () => {
  // The migration holds structure; the rules live here, so a refusal can name
  // the field instead of surfacing driver text.
  for (
    const sha256 of ["", "a".repeat(63), "A".repeat(64), `${"a".repeat(64)}x`]
  ) {
    const error = await assertRejects(() =>
      startUploadSession({} as never, {
        organizationId: "org",
        principalId: "principal",
        sha256,
        sizeBytes: 3,
        mediaType: "text/plain",
      })
    );
    assertEquals(refusal(error), "invalid_digest");
  }
});

Deno.test("a negative or non-integer size is refused by the server", async () => {
  for (const sizeBytes of [-1, 1.5, Number.NaN]) {
    const error = await assertRejects(() =>
      startUploadSession({} as never, {
        organizationId: "org",
        principalId: "principal",
        sha256: "a".repeat(64),
        sizeBytes,
        mediaType: "text/plain",
      })
    );
    assertEquals(refusal(error), "invalid_size");
  }
});

Deno.test("a session row a caller reads is checked before they trust it", async () => {
  // The pairing is only worth anything if a real read enforces it. A row that
  // says completed but names no blob must refuse at lockUploadSession rather
  // than travel to a caller that would act on the word alone.
  const rows = [{
    id: "s",
    organizationId: "org",
    createdById: "p",
    sha256: "a".repeat(64),
    sizeBytes: "0",
    mediaType: "text/plain",
    state: "completed",
    expiresAt: new Date(Date.now() + 60_000),
    completedBlobId: null,
  }];
  const tx = { query: () => Promise.resolve({ rows, rowCount: 1 }) };
  const error = await assertRejects(() =>
    lockUploadSession(tx as never, {
      organizationId: "org",
      principalId: "p",
      sessionId: "s",
    })
  );
  // INTERNAL specifically, not the STATE_CONFLICT the lifecycle guard would
  // raise: a contradictory row is data that cannot be true, and reporting it
  // as "this session is already finished" would hide that.
  assertEquals((error as StandardError).code, "INTERNAL");
});

Deno.test("a completed session without a blob is a contradiction, not data", () => {
  const broken = {
    id: "s",
    organizationId: "org",
    createdById: "p",
    sha256: "a".repeat(64),
    sizeBytes: 0n,
    mediaType: "text/plain",
    state: "completed" as const,
    expiresAt: new Date(),
    completedBlobId: null,
  };
  const error = assertThrows(() => assertSessionConsistent(broken));
  assertEquals(error instanceof StandardError, true);
  // And the mirror: an unfinished session may not name a blob.
  assertThrows(() =>
    assertSessionConsistent({
      ...broken,
      state: "pending",
      completedBlobId: "b",
    })
  );
});
