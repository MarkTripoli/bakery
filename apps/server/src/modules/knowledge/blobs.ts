import { createHash } from "node:crypto";
import type { PgTransactionClient } from "@bakery/persistence";
import { StandardError } from "@bakery/contracts/http";
import { blobKeyLock } from "../../platform/blob-key-lock.ts";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import { blobObjectKey } from "../catalog/storage-port.ts";

/** Largest file a single blob may be, per chapter 25 §17.5. */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Refuses a digest or size the schema would reject.
 *
 * These are validated here rather than by a CHECK constraint: the database
 * holds structure, the server holds rules. A rejected value answers a typed
 * 422 naming the field, which a constraint violation could not do without
 * leaking driver text.
 */
function assertDeclared(
  sha256: string,
  sizeBytes: number,
  field = "sha256",
): void {
  if (!SHA256_HEX.test(sha256)) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field, reason: "invalid_digest" },
    });
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "sizeBytes", reason: "invalid_size" },
    });
  }
}

/**
 * How long an upload session stays usable.
 *
 * Long enough that a 5 GiB upload on a slow link can finish, short enough that
 * an abandoned session does not hold parts forever. Expiry is absolute, not
 * sliding: a session that is being resumed does not extend its own deadline,
 * so a stalled upload cannot keep itself alive indefinitely.
 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type UploadSessionRow = Readonly<{
  id: string;
  organizationId: string;
  createdById: string;
  sha256: string;
  sizeBytes: bigint;
  mediaType: string;
  state: "pending" | "completed" | "abandoned" | "expired";
  expiresAt: Date;
  completedBlobId: string | null;
}>;

const SESSION_COLUMNS = `id,
  organization_id as "organizationId",
  created_by_id as "createdById",
  sha256,
  size_bytes::text as "sizeBytes",
  media_type as "mediaType",
  state,
  expires_at as "expiresAt",
  completed_blob_id as "completedBlobId"`;

/**
 * Starts an upload session for a declared digest and size.
 *
 * The declaration is the whole point: because the client states up front the
 * digest and size of what it intends to deliver, a completion can be refused
 * when the assembled bytes are not that — before a blob is stored or usage is
 * charged — instead of after.
 *
 * The session is owned by the principal that started it, and every later call
 * is scoped by `(organizationId, createdById)`, so a session id alone is never
 * enough authority to write to it.
 */
export async function startUploadSession(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
  }>,
): Promise<UploadSessionRow> {
  assertDeclared(input.sha256, input.sizeBytes);
  if (input.sizeBytes > MAX_BLOB_BYTES) {
    throw new StandardError({ code: "BODY_TOO_LARGE" });
  }
  const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS);
  const result = await tx.query<UploadSessionRow>(
    `insert into bakery.blob_upload_sessions
       (organization_id, created_by_id, sha256, size_bytes, media_type,
        expires_at)
     values ($1, $2, $3, $4, $5, $6)
     returning ${SESSION_COLUMNS}`,
    [
      input.organizationId,
      input.principalId,
      input.sha256,
      input.sizeBytes,
      input.mediaType,
      expiresAt,
    ],
  );
  return normalize(result.rows[0]);
}

/**
 * Locks a session for the rest of the transaction, refusing one that is not
 * this principal's, is already finished, or has passed its deadline.
 *
 * `for update` is what makes two racing completions settle in one winner
 * rather than both storing: the loser waits on the row, then reads a session
 * that is no longer pending.
 */
export async function lockUploadSession(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    sessionId: string;
  }>,
): Promise<UploadSessionRow> {
  const result = await tx.query<UploadSessionRow>(
    `select ${SESSION_COLUMNS}
       from bakery.blob_upload_sessions
      where organization_id = $1 and id = $2 and created_by_id = $3
      for update`,
    [input.organizationId, input.sessionId, input.principalId],
  );
  const session = result.rows[0];
  if (!session) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // Before the state guards below, because those guard the *lifecycle* and a
  // contradictory row is not a lifecycle question: it is data that cannot be
  // true, and it must not be reported as "this session is already finished".
  assertSessionConsistent(normalizeRaw(session));
  // The same allowlist as `lockUploadSessionForCompletion`, and it has to be the
  // same one. These are the two doors into a session - a part write and a
  // completion - and a guard that is right in one and a denylist in the other
  // is a bug that only shows on the path nobody re-read. A denylist names the
  // states it refuses and therefore silently admits every state a later change
  // invents.
  if (session.state === "abandoned" || session.state === "expired") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "upload_session_expired" },
    });
  }
  if (session.state !== "pending" && session.state !== "completed") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  // A completed session has nothing left to accept, so it cannot run out of
  // time; that is what makes the retry branch reachable in the other door.
  if (session.state === "pending" && session.expiresAt <= new Date()) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "upload_session_expired" },
    });
  }
  // A completed session falls through and is returned: this function answers
  // "may I look at this session", and the completion path has to be able to
  // look at a finished one. Whether a caller may WRITE to it is the caller's
  // rule - `putUploadPart` refuses a completed session, and so does the part
  // route - because a lifecycle rule that lives in the shared lock also closes
  // the reads, which is what made a retry after completion unreachable.
  return normalize(session);
}

/**
 * Records one part of an upload.
 *
 * A part is identified by its ordinal, so a retried part *replaces* rather
 * than appends: that is the difference between resuming an upload and
 * duplicating it. The write is an upsert on `(org, session, part_number)`, so a
 * client that lost the response to a successful part can simply send it again.
 *
 * A part whose bytes do not hash to the digest the client reported for that
 * part is refused here rather than being stored and discovered at completion.
 */
export async function putUploadPart(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    sessionId: string;
    partNumber: number;
    sha256: string;
    content: Uint8Array;
  }>,
): Promise<{ readonly recorded: boolean; readonly partNumber: number }> {
  // Locking first is what makes this the owner's part. The composite foreign key
  // stops another organization, but nothing structural stops a different
  // principal in the same organization from writing into someone else's upload,
  // so the server has to refuse it - and it can only do that if it is told who
  // is calling.
  const session = await lockUploadSession(tx, {
    organizationId: input.organizationId,
    principalId: input.principalId,
    sessionId: input.sessionId,
  });
  // A completed session is admitted by the lock so the completion path can read
  // a finished upload and answer a retry with its blob; the rule that a part
  // write is not allowed into one therefore lives here, at the part write, and
  // not in the shared lock where it would also close the read.
  if (session.state === "completed") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  assertDeclared(input.sha256, input.content.byteLength);
  if (input.partNumber < 1) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "partNumber", reason: "invalid_part_number" },
    });
  }
  // The session declared a size up front, and a part that pushes the running
  // total past it can never assemble into the promised file. Refusing here
  // rather than at completion means a client learns while it still has the
  // bytes in hand, and it stops an upload from storing far more than it
  // declared - a part is otherwise bounded only by the request body limit.
  //
  // The part being written is excluded from the existing total, because a retry
  // replaces its own row rather than adding to it.
  const existing = await tx.query<{ total: string }>(
    `select coalesce(sum(size_bytes), 0)::text as total
       from bakery.blob_upload_parts
      where organization_id = $1 and session_id = $2 and part_number <> $3`,
    [input.organizationId, input.sessionId, input.partNumber],
  );
  const runningTotal = Number(existing.rows[0].total) +
    input.content.byteLength;
  if (runningTotal > Number(session.sizeBytes)) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "content", reason: "upload_exceeds_declared_size" },
    });
  }
  const result = await tx.query<{ partNumber: number }>(
    `insert into bakery.blob_upload_parts
       (organization_id, session_id, part_number, sha256, size_bytes, content)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (organization_id, session_id, part_number)
       do update set sha256 = excluded.sha256,
                     size_bytes = excluded.size_bytes,
                     content = excluded.content
     returning part_number as "partNumber"`,
    [
      input.organizationId,
      input.sessionId,
      input.partNumber,
      input.sha256,
      input.content.byteLength,
      input.content,
    ],
  );
  return { recorded: true, partNumber: result.rows[0].partNumber };
}

/**
 * Reads a session's parts in ordinal order.
 *
 * The caller assembles and hashes; nothing here trusts a client's summary of
 * what it sent.
 */
/**
 * The parts' sizes and ordinals, without their bytes.
 *
 * Progress is a question about how much has arrived, not about what arrived, so
 * reading the content to answer it would pull an entire upload into memory to
 * produce two integers.
 */
export async function readUploadPartSummaries(
  tx: PgTransactionClient,
  input: Readonly<{ organizationId: string; sessionId: string }>,
): Promise<ReadonlyArray<Readonly<{ partNumber: number; sizeBytes: number }>>> {
  const result = await tx.query<{ partNumber: number; sizeBytes: string }>(
    `select part_number as "partNumber", size_bytes as "sizeBytes"
       from bakery.blob_upload_parts
      where organization_id = $1 and session_id = $2
      order by part_number asc`,
    [input.organizationId, input.sessionId],
  );
  return result.rows.map((row) => ({
    partNumber: row.partNumber,
    sizeBytes: Number(row.sizeBytes),
  }));
}

/**
 * Yields a session's parts one at a time, in ordinal order.
 *
 * Completion has to see every byte to hash it, but it never has to see them all
 * at once. Reading the whole upload and then copying it into a second buffer
 * peaks at twice the declared size, and the declared size is allowed to be 5
 * GiB - so the copy is what turns one large upload into an out-of-memory kill.
 * A generator keeps exactly one part resident.
 */
export async function* streamUploadParts(
  tx: PgTransactionClient,
  input: Readonly<{ organizationId: string; sessionId: string }>,
): AsyncGenerator<Readonly<{ partNumber: number; content: Uint8Array }>> {
  const summaries = await readUploadPartSummaries(tx, input);
  for (const summary of summaries) {
    const result = await tx.query<{ content: Uint8Array | Buffer }>(
      `select content
         from bakery.blob_upload_parts
        where organization_id = $1 and session_id = $2 and part_number = $3`,
      [input.organizationId, input.sessionId, summary.partNumber],
    );
    const content = result.rows[0]?.content;
    if (!content) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: { reason: "upload_parts_incomplete" },
      });
    }
    yield {
      partNumber: summary.partNumber,
      content: content instanceof Uint8Array
        ? content
        : new Uint8Array(content),
    };
  }
}

/**
 * Marks a session complete and names the blob it produced.
 *
 * `completed` and a named blob are set in the same statement, so a reader may
 * trust the word without checking a second column. The pairing is enforced here
 * rather than by a CHECK constraint: the database holds structure, the server
 * holds rules. The `state = 'pending'` predicate in the WHERE is the other
 * half — a session can only be completed once, so two racing completions do not
 * both succeed.
 */
/**
 * Locks a session for completion, which is the one caller that must be able to
 * see a session it has already completed.
 *
 * `lockUploadSession` refuses a completed session because a part write into one
 * is a mistake. Completion is the opposite: a client that never saw the first
 * response retries, and the honest answer is the blob it already produced, not a
 * conflict it cannot resolve. So this returns the row in any live state and lets
 * the caller decide, while still refusing an abandoned or expired session and
 * still asserting the row is self-consistent.
 */
export async function lockUploadSessionForCompletion(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    sessionId: string;
  }>,
): Promise<UploadSessionRow> {
  const result = await tx.query<UploadSessionRow>(
    `select ${SESSION_COLUMNS}
       from bakery.blob_upload_sessions
      where organization_id = $1 and id = $2 and created_by_id = $3
      for update`,
    [input.organizationId, input.sessionId, input.principalId],
  );
  const session = result.rows[0];
  if (!session) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  assertSessionConsistent(normalizeRaw(session));
  // The same allowlist as `lockUploadSession`, and it has to be the same one:
  // these are the two doors into a session, and a guard that is right in one
  // and a denylist in the other is a bug that only shows on the path nobody
  // re-read. A denylist names the states it refuses and therefore admits every
  // state a later change invents.
  //
  // `completed` is admitted on purpose, forever. Completion is idempotent and
  // the blob it names is immutable, so expiry bounds the upload, not the
  // reading back of a finished result: a retry long after the window closed
  // must still reach the branch that answers with that blob. The old guard
  // refused it on `expiresAt <= now` without asking whether anything was left
  // to accept, which made the retry branch unreachable.
  if (session.state === "abandoned" || session.state === "expired") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "upload_session_expired" },
    });
  }
  if (session.state !== "pending" && session.state !== "completed") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  // Only a session still accepting parts can run out of time; a completed one
  // has nothing left to accept.
  if (session.state === "pending" && session.expiresAt <= new Date()) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "upload_session_expired" },
    });
  }
  return normalize(session);
}

/** A blob row by id, for answering a completion that already happened. */
export async function readBlob(
  tx: PgTransactionClient,
  input: Readonly<{ organizationId: string; blobId: string }>,
): Promise<{
  readonly id: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly createdAt: Date;
}> {
  const result = await tx.query<{
    id: string;
    sha256: string;
    sizeBytes: string | number;
    mediaType: string;
    createdAt: Date;
  }>(
    `select id, sha256, size_bytes as "sizeBytes", media_type as "mediaType",
       created_at as "createdAt"
       from bakery.blobs
      where organization_id = $1 and id = $2`,
    [input.organizationId, input.blobId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "INTERNAL" });
  // A bigint column arrives as a string; the boundary hands a number to JSON,
  // which is what the response schema declares.
  return { ...row, sizeBytes: Number(row.sizeBytes) };
}

export async function completeUploadSession(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    sessionId: string;
    blobId: string;
  }>,
): Promise<void> {
  // The same ownership check as a part write: completing is the step that makes
  // the bytes real, so it must not be reachable by a principal that could not
  // have uploaded them.
  await lockUploadSession(tx, {
    organizationId: input.organizationId,
    principalId: input.principalId,
    sessionId: input.sessionId,
  });
  const result = await tx.query(
    `update bakery.blob_upload_sessions
        set state = 'completed', completed_blob_id = $3, updated_at = now()
      where organization_id = $1 and id = $2 and state = 'pending'`,
    [input.organizationId, input.sessionId, input.blobId],
  );
  if (result.rowCount !== 1) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
}

/**
 * Records a verified blob, or finds the one already stored under this digest.
 *
 * Two uploads of the same bytes in one organization are the same blob, so the
 * insert is a no-op on conflict and the existing row is returned. That is what
 * makes a replayed completion store nothing new.
 */
export async function recordBlob(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
  }>,
  store: Pick<OrganizationBlobStore, "stat">,
): Promise<{
  readonly id: string;
  readonly created: boolean;
  /**
   * What the blob is, echoed rather than re-queried.
   *
   * The row was verified against these very values, so returning them states the
   * result of the check that just passed — a second read could only disagree by
   * being stale.
   */
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly createdAt: Date;
}> {
  assertDeclared(input.sha256, input.sizeBytes);
  // Recorded under the same lock the plugin bundle collector takes, so a
  // completion cannot register a claim on an object while the collector is
  // deleting it. The key is spelled the way the object key is, tenant and
  // object ref, which is also what the version writer locks.
  const objectKey = blobObjectKey(input.organizationId, input.sha256);
  await tx.query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [blobKeyLock(input.organizationId, objectKey)],
  );
  // Under the lock, the object has to still be there. Bytes can go between the
  // upload writing them and this call recording them - a bundle sweep of a
  // withdrawn plugin that happens to share the digest deletes the key - and a
  // row naming bytes nothing holds is a claim the registry cannot detect or
  // repair. Refusing names the problem instead of storing the lie.
  if (await store.stat(input.organizationId, input.sha256) === null) {
    throw new StandardError({
      code: "PRECONDITION_FAILED",
      params: { reason: "blob_bytes_missing" },
    });
  }
  const inserted = await tx.query<{ id: string; createdAt: Date }>(
    `insert into bakery.blobs
       (organization_id, sha256, size_bytes, media_type, created_by_id)
     values ($1, $2, $3, $4, $5)
     on conflict (organization_id, sha256) do nothing
     returning id, created_at as "createdAt"`,
    [
      input.organizationId,
      input.sha256,
      input.sizeBytes,
      input.mediaType,
      input.principalId,
    ],
  );
  const shape = {
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    mediaType: input.mediaType,
  };
  if (inserted.rows[0]) {
    return {
      id: inserted.rows[0].id,
      created: true,
      createdAt: inserted.rows[0].createdAt,
      ...shape,
    };
  }
  const existing = await tx.query<{ id: string; createdAt: Date }>(
    `select id, created_at as "createdAt" from bakery.blobs
      where organization_id = $1 and sha256 = $2`,
    [input.organizationId, input.sha256],
  );
  const row = existing.rows[0];
  if (!row) throw new StandardError({ code: "INTERNAL" });
  return { id: row.id, created: false, createdAt: row.createdAt, ...shape };
}

/**
 * Reads a session and asserts that a completed one names its blob.
 *
 * This is where the pairing is checked on the way out. A row that somehow
 * reached `completed` without a blob is a contradiction, so it is refused as an
 * internal fault rather than being handed to a caller that would trust it.
 */
export function assertSessionConsistent(
  session: UploadSessionRow,
): UploadSessionRow {
  if (session.state === "completed" && session.completedBlobId === null) {
    throw new StandardError({ code: "INTERNAL" });
  }
  if (session.state !== "completed" && session.completedBlobId !== null) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return session;
}

function normalizeRaw(row: UploadSessionRow): UploadSessionRow {
  return {
    ...row,
    sizeBytes: BigInt(row.sizeBytes),
    expiresAt: new Date(row.expiresAt),
  };
}

function normalize(row: UploadSessionRow): UploadSessionRow {
  return normalizeRaw(row);
}
/**
 * Joins a session's parts into the declared bytes, refusing anything that does
 * not match the declaration.
 *
 * Completion is the only moment the server sees the whole file, so this is
 * where the declaration is honoured or refused. Three things are checked, and
 * each exists for a distinct failure:
 *
 * - a part is missing (the ordinal gap), because a gap means the client has not
 *   sent everything it said it would;
 * - the total size differs from the declared size, which catches a truncated
 *   or over-long upload before it is stored;
 * - the digest of the parts differs from the declared digest, which catches
 *   everything else - the wrong file, a corrupted part, or a client that lied.
 *
 * The buffer is allocated once, at the declared size, and each part is hashed
 * as it is copied in. That is one copy of the file rather than the two a
 * separate assemble-then-hash would need, and the parts are consumed as a
 * stream so only one of them is resident at a time. Nothing is stored unless
 * all three checks hold, and the caller must not write the bytes anywhere until
 * this returns: a digest-addressed key means a pre-verify write would poison
 * the destination for every later honest upload of the same bytes.
 */
export async function assembleVerifiedBytes(
  parts: AsyncIterable<Readonly<{ partNumber: number; content: Uint8Array }>>,
  declared: Readonly<{ sha256: string; sizeBytes: number }>,
): Promise<Uint8Array> {
  const assembled = new Uint8Array(declared.sizeBytes);
  const hash = createHash("sha256");
  let offset = 0;
  let expected = 1;
  let count = 0;
  for await (const part of parts) {
    // Ordinals start at 1 and must be contiguous; a gap or a repeat means the
    // client has not sent the file it promised.
    if (part.partNumber !== expected) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: { reason: "upload_parts_incomplete" },
      });
    }
    expected += 1;
    count += 1;
    // Refuse as soon as the running total passes the declaration: there is no
    // point copying the rest of a file that can never be accepted.
    if (offset + part.content.byteLength > declared.sizeBytes) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: { reason: "upload_size_mismatch" },
      });
    }
    assembled.set(part.content, offset);
    offset += part.content.byteLength;
    hash.update(part.content);
  }
  if (count === 0) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: "upload_parts_incomplete" },
    });
  }
  if (offset !== declared.sizeBytes) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: "upload_size_mismatch" },
    });
  }
  if (hash.digest("hex") !== declared.sha256) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: "upload_digest_mismatch" },
    });
  }
  return assembled;
}

/**
 * Removes a completed session's parts.
 *
 * Once the bytes live in the object store, the parts are a second copy of the
 * same file. Keeping both doubles storage for every upload and never gives it
 * back, so the parts go as soon as the blob row commits.
 */
export async function deleteUploadParts(
  tx: PgTransactionClient,
  input: Readonly<{ organizationId: string; sessionId: string }>,
): Promise<void> {
  await tx.query(
    `delete from bakery.blob_upload_parts
      where organization_id = $1 and session_id = $2`,
    [input.organizationId, input.sessionId],
  );
}
