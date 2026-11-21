import type { PgTransactionClient } from "@bakery/persistence";

/**
 * Every table whose rows keep one blob's bytes alive.
 *
 * A blob row is the organization's single copy of some bytes, keyed by their
 * SHA-256. Collection is destructive and irreversible, so the question "does
 * anything still want these bytes" has to be asked of the whole schema, not of
 * the table the collector was written for. This list is that answer, and it is
 * the only place the answer lives: the existence check and the sweep's
 * candidate query are both built from it, so a table added here is protected by
 * every caller at once.
 *
 * `tests/rails/blob-reference-registry_test.ts` reads the migrations and fails
 * when a foreign key to `bakery.blobs` is not on this list, so the list cannot
 * quietly fall behind the schema.
 *
 * Three details are load-bearing in the entries themselves:
 *
 * - `liveCondition` says which rows of that table do *not* count. A purged
 *   artifact version has had its `blob_id` cleared and must not keep bytes
 *   alive; a closed upload session has given up its claim. Counting them anyway
 *   would turn every collected version into a permanent pin.
 * - `names` says whether the row points at the blob row or at its bytes. An
 *   upload in flight knows only the digest it promised, so it can only be found
 *   by digest; a published version knows the row.
 * - A completed upload session is live until it expires. The session names the
 *   blob row at completion, but the version that will use it is published a
 *   moment later, and a sweep in that gap would delete bytes the publish is
 *   about to name. `expires_at` is the grace window, and it is the session's
 *   own stated lifetime rather than a number invented here.
 */
export type BlobReferenceKind = Readonly<{
  kind: string;
  table: string;
  /** The foreign key this reference rides on, or null when the column has none. */
  constraint: string | null;
  /** Whether the column holds a blob id or a SHA-256 digest. */
  names: "blob" | "digest";
  column: string;
  /** Rows of this table that do not hold the bytes alive. */
  liveCondition: string;
}>;

export const blobReferenceKinds: readonly BlobReferenceKind[] = [
  {
    kind: "artifact-version",
    table: "artifact_versions",
    constraint: "artifact_versions_blob_fk",
    names: "blob",
    column: "blob_id",
    liveCondition: "purged_at is null",
  },
  {
    // A completed upload has claimed the blob but no version names it yet.
    kind: "upload-session-completed",
    table: "blob_upload_sessions",
    constraint: "blob_upload_sessions_blob_fk",
    names: "blob",
    column: "completed_blob_id",
    liveCondition: "state = 'completed' and expires_at > now()",
  },
  {
    // A file version names a blob when its content was stored, rather than
    // written inline: the working-area rows (#715) keep the bytes a person is
    // still editing, and pruning, the trash reaper and a working-area purge all
    // delete the row. Restricting the delete means the row goes first, so this
    // entry is what stops the sweep taking bytes a version still shows.
    kind: "storage-file-version",
    table: "storage_file_versions",
    constraint: "storage_file_versions_blob_fk",
    names: "blob",
    column: "blob_id",
    liveCondition: "true",
  },
  {
    // A probe row describes bytes; it does not want them. `liveCondition`
    // "false" says exactly that: a blob whose only remaining row is its probe is
    // collectable, and the cascade takes the probe with the bytes it described.
    // Listing it is not optional even so -- the rail asks every foreign key this
    // question, and "no, this one does not count" is an answer, while silence
    // would be a table nothing had considered.
    kind: "blob-probe",
    table: "blob_probes",
    constraint: "blob_probes_blob_fk",
    names: "blob",
    column: "blob_id",
    liveCondition: "false",
  },
  {
    // A queued probe is not a reader either: it asks a question about bytes that
    // some other row already holds, and a sweep that takes them first makes the
    // request answer "gone" instead of measuring them. Like a probe row, it does
    // not keep the bytes alive by itself -- the version it names does -- so the
    // entry is here to answer the rail, not to pin anything.
    kind: "probe-request",
    table: "probe_requests",
    constraint: "probe_requests_blob_fk",
    names: "blob",
    column: "blob_id",
    liveCondition: "false",
  },
  {
    // An upload in flight holds the bytes it is about to assemble and verify.
    // It knows the digest it was promised, never a blob row.
    kind: "upload-session-pending",
    table: "blob_upload_sessions",
    constraint: null,
    names: "digest",
    column: "sha256",
    liveCondition: "state = 'pending' and expires_at > now()",
  },
];

function assertRegistry(kinds: readonly BlobReferenceKind[]): void {
  if (kinds.length === 0) {
    // An empty registry would make "does anything reference this" answer false
    // for every blob, which is a delete the schema never agreed to.
    throw new TypeError("BLOB_REFERENCE_REGISTRY_IS_EMPTY");
  }
}

/**
 * Every row in one organization that still holds this blob's bytes alive.
 *
 * One statement built from the registry, so no caller can check a subset of the
 * tables. A digest-named reference is joined to the blob row to learn the
 * digest, which is why the statement takes a blob id and not a digest: the id
 * is what the caller has, and it also carries the organization.
 */
export function liveBlobReferenceQuery(
  kinds: readonly BlobReferenceKind[],
): string {
  assertRegistry(kinds);
  const parts = kinds.map((kind) =>
    kind.names === "blob"
      ? `select 1 from bakery.${kind.table} held
          where held.organization_id = $1 and held.${kind.column} = $2
            and (${kind.liveCondition})`
      : `select 1
           from bakery.${kind.table} held
           join bakery.blobs blob
             on blob.organization_id = held.organization_id
            and blob.id = $2
          where held.organization_id = $1
            and held.${kind.column} = blob.sha256
            and (${kind.liveCondition})`
  );
  return `select 1 from (${parts.join("\n union all\n")}) live limit 1`;
}

/** Whether any registered table still holds this blob's bytes alive. */
export async function hasLiveBlobReference(
  transaction: PgTransactionClient,
  input: Readonly<{ organizationId: string; blobId: string }>,
  kinds: readonly BlobReferenceKind[] = blobReferenceKinds,
): Promise<boolean> {
  const result = await transaction.query(liveBlobReferenceQuery(kinds), [
    input.organizationId,
    input.blobId,
  ]);
  return result.rows.length > 0;
}

/**
 * The sweep's candidate query: blobs no registered table holds alive.
 *
 * Built from the same registry as `hasLiveBlobReference`, so a table that
 * protects a blob from `collectBlob` also keeps it out of the candidate list.
 * Being a convenience rather than the authority, it runs on the owner
 * connection without a lock: `collectBlob` decides again under the row lock.
 */
export function collectableBlobQuery(
  kinds: readonly BlobReferenceKind[],
): string {
  assertRegistry(kinds);
  const guards = kinds.map((kind) =>
    kind.names === "blob"
      ? `not exists (
          select 1 from bakery.${kind.table} held
           where held.organization_id = blob.organization_id
             and held.${kind.column} = blob.id
             and (${kind.liveCondition})
        )`
      : `not exists (
          select 1 from bakery.${kind.table} held
           where held.organization_id = blob.organization_id
             and held.${kind.column} = blob.sha256
             and (${kind.liveCondition})
        )`
  );
  return `select blob.organization_id, blob.id
            from bakery.blobs blob
           where ${guards.join("\n             and ")}
           order by blob.created_at
           limit $1`;
}
