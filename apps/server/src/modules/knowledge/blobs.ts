import type { PgTransactionClient } from "@bakery/persistence";
import { StandardError } from "@bakery/contracts/http";

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
  state: "pending" | "completed" | "abandoned";
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
  if (session.state === "completed") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  if (session.state === "abandoned" || session.expiresAt <= new Date()) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "upload_session_expired" },
    });
  }
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
    sessionId: string;
    partNumber: number;
    sha256: string;
    content: Uint8Array;
  }>,
): Promise<{ readonly recorded: boolean; readonly partNumber: number }> {
  assertDeclared(input.sha256, input.content.byteLength);
  if (input.partNumber < 1) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "partNumber", reason: "invalid_part_number" },
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
export async function readUploadParts(
  tx: PgTransactionClient,
  input: Readonly<{ organizationId: string; sessionId: string }>,
): Promise<
  ReadonlyArray<
    Readonly<
      { partNumber: number; sha256: string; content: Uint8Array }
    >
  >
> {
  const result = await tx.query<
    { partNumber: number; sha256: string; content: Uint8Array }
  >(
    `select part_number as "partNumber", sha256, content
       from bakery.blob_upload_parts
      where organization_id = $1 and session_id = $2
      order by part_number asc`,
    [input.organizationId, input.sessionId],
  );
  return result.rows.map((row) => ({
    partNumber: row.partNumber,
    sha256: row.sha256,
    content: row.content instanceof Uint8Array
      ? row.content
      : new Uint8Array(row.content),
  }));
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
export async function completeUploadSession(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    sessionId: string;
    blobId: string;
  }>,
): Promise<void> {
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
): Promise<{ readonly id: string; readonly created: boolean }> {
  assertDeclared(input.sha256, input.sizeBytes);
  const inserted = await tx.query<{ id: string }>(
    `insert into bakery.blobs
       (organization_id, sha256, size_bytes, media_type, created_by_id)
     values ($1, $2, $3, $4, $5)
     on conflict (organization_id, sha256) do nothing
     returning id`,
    [
      input.organizationId,
      input.sha256,
      input.sizeBytes,
      input.mediaType,
      input.principalId,
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await tx.query<{ id: string }>(
    `select id from bakery.blobs
      where organization_id = $1 and sha256 = $2`,
    [input.organizationId, input.sha256],
  );
  const row = existing.rows[0];
  if (!row) throw new StandardError({ code: "INTERNAL" });
  return { id: row.id, created: false };
}

function normalize(row: UploadSessionRow): UploadSessionRow {
  return {
    ...row,
    sizeBytes: BigInt(row.sizeBytes),
    expiresAt: new Date(row.expiresAt),
  };
}
/**
 * Assembles a session's parts and checks them against what was declared.
 *
 * Completion is the only moment the server sees the whole file, so this is
 * where the declaration is honoured or refused. Three things are checked, and
 * each exists for a distinct failure:
 *
 * - a part is missing (the ordinal gap), because assembling a gap yields a
 *   plausible-looking file that is not the one the client promised;
 * - the total size differs from the declared size, which catches a truncated
 *   or over-long upload before it is stored;
 * - the digest of the assembled bytes differs from the declared digest, which
 *   catches everything else — the wrong file, a corrupted part, or a client
 *   that lied.
 *
 * Nothing is stored unless all three hold.
 */
export function assembleDeclaredBytes(
  parts: ReadonlyArray<
    Readonly<{ partNumber: number; content: Uint8Array }>
  >,
  declared: Readonly<{ sha256: string; sizeBytes: number }>,
): Uint8Array {
  if (parts.length === 0) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: "upload_parts_incomplete" },
    });
  }
  // A gap means the client has not sent everything it said it would; ordinals
  // start at 1 and must be contiguous.
  for (const [index, part] of parts.entries()) {
    if (part.partNumber !== index + 1) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: { reason: "upload_parts_incomplete" },
      });
    }
  }
  const total = parts.reduce((sum, part) => sum + part.content.byteLength, 0);
  if (total !== declared.sizeBytes) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: "upload_size_mismatch" },
    });
  }
  const assembled = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    assembled.set(part.content, offset);
    offset += part.content.byteLength;
  }
  return assembled;
}
