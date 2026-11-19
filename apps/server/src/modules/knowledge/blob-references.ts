import type { PgTransactionClient } from "@bakery/persistence";

/**
 * Which artifact rows keep a blob's bytes alive.
 *
 * A blob row is the organization's single copy of some bytes, keyed by their
 * SHA-256. Nothing referenced it back: the plugin-bundle collector could only
 * ask the registry "does a blob row exist at this digest" and had to answer
 * "then keep the object", because it had no way to learn whether any artifact
 * version still wanted those bytes. That conservatism is safe and permanently
 * wrong - a dead artifact blob pinned a plugin bundle's object forever.
 *
 * This is the missing direction of the reference. It answers, for one blob,
 * which artifact versions name it, so a collector can decide instead of
 * guessing.
 *
 * Two details are load-bearing:
 *
 * - A purged version does not count. Collection clears `blob_id` along with the
 *   inline content, so a purged row cannot keep bytes alive; counting the row
 *   anyway would make every purged version a permanent pin.
 * - The lookup is by the blob's id, not only its digest. A version names a blob
 *   row, and that row carries the organization; resolving the digest first would
 *   be a second, avoidable question about tenancy.
 */
export const blobReferenceKinds = [
  {
    kind: "artifact-version",
    table: "artifact_versions",
    constraint: "artifact_versions_blob_fk",
    protection: "active",
  },
] as const;

/** One live reference: the artifact version that names this blob. */
export type BlobReference = Readonly<{
  organizationId: string;
  artifactId: string;
  versionId: string;
}>;

/**
 * Every artifact version in one organization that still names this blob.
 *
 * A caller that only needs yes-or-no should use `hasLiveBlobReference`, which
 * stops at the first row rather than materialising a list a collector would
 * only ask the length of.
 */
export async function readBlobReferences(
  transaction: PgTransactionClient,
  input: Readonly<{ organizationId: string; blobId: string }>,
): Promise<readonly BlobReference[]> {
  const result = await transaction.query<
    { artifactId: string; versionId: string }
  >(
    `select artifact_id as "artifactId", id as "versionId"
       from bakery.artifact_versions
      where organization_id = $1 and blob_id = $2 and purged_at is null
      order by created_at, id`,
    [input.organizationId, input.blobId],
  );
  return result.rows.map((row) => ({
    organizationId: input.organizationId,
    artifactId: row.artifactId,
    versionId: row.versionId,
  }));
}

/**
 * Whether any live artifact version still names this blob.
 *
 * This is the question the plugin-bundle collector needed and could not ask, so
 * it must be answerable by digest as well as by id: the bundle collector knows
 * an object key and a digest, never a blob id.
 */
export async function hasLiveBlobReference(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    blobId?: string;
    sha256?: string;
  }>,
): Promise<boolean> {
  if (input.blobId === undefined && input.sha256 === undefined) {
    // Nothing to look up is not the same as "nothing references it". A caller
    // that supplies neither is asking a question this cannot answer, and an
    // answer of `false` would let it delete bytes nothing had checked.
    throw new TypeError("BLOB_REFERENCE_LOOKUP_REQUIRES_ID_OR_DIGEST");
  }
  const result = await transaction.query(
    `select 1
       from bakery.artifact_versions version
      where version.organization_id = $1
        and version.purged_at is null
        and ($2::uuid is null or version.blob_id = $2)
        and ($3::text is null or version.sha256 = $3)
      limit 1`,
    [input.organizationId, input.blobId ?? null, input.sha256 ?? null],
  );
  return result.rows.length > 0;
}
