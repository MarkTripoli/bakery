export type SkillObject = Readonly<{
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}>;

export interface SkillObjectStore {
  putIfAbsent(
    objectKey: string,
    content: Uint8Array,
    expectedSha256: string,
  ): Promise<void>;
  read(
    objectKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<Uint8Array>;
  recover(
    objectKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<void>;
  /**
   * The stored size of one object, or null when it is not there.
   *
   * `read` needs a size before it can verify bytes, so a caller that holds a
   * digest but not a size - publishing a plugin version from an already
   * uploaded bundle, for instance - has no other way to ask. Returning null
   * rather than throwing keeps "absent" and "unreadable" apart at the call
   * site.
   */
  stat(objectKey: string): Promise<{ sizeBytes: number } | null>;
  /**
   * Remove one object, answering whether it was there.
   *
   * Retention collection is the only caller: a bundle that nothing may install
   * again is reclaimed here rather than left to an out-of-band sweep, because
   * a sweep has no way to know that an install no longer pins it. Deleting an
   * absent key is not an error - a purged version may be collected twice after
   * a crash between the store call and the row update - so `false` reports
   * "there was nothing to reclaim", not "the call failed".
   */
  delete(objectKey: string): Promise<boolean>;
  list(): AsyncIterable<SkillObject>;
}

export class SkillFileStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SkillFileStoreError";
  }
}

export function assertSkillObjectKey(key: string): void {
  if (
    !/^organizations\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/skill-versions\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/sha256\/[0-9a-f]{64}$/
      .test(key)
  ) {
    throw new SkillFileStoreError("SKILL_FILE_KEY_INVALID");
  }
}

/**
 * The organisation is the first segment of every key, which is what makes
 * tenancy structural rather than a filter someone can forget to add. A key
 * that starts anywhere else, or that carries any extra segment, is refused
 * before a store call is made.
 */
const BLOB_KEY =
  /^organizations\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/blobs\/sha256\/([0-9a-f]{64})$/;

/**
 * A blob is one organisation's bytes under their SHA-256.
 *
 * The digest is in the key on purpose: it is what makes the write idempotent
 * (two writers of the same bytes address the same object) and it is what a
 * reader verifies against. The organisation is a separate segment so the same
 * digest in two organisations is two objects — deduplication within one
 * organisation, never across (O43).
 */
export function blobObjectKey(organizationId: string, sha256: string): string {
  const key = `organizations/${organizationId}/blobs/sha256/${sha256}`;
  assertBlobObjectKey(key);
  return key;
}

/**
 * Refuses anything that is not exactly `organizations/{org}/blobs/sha256/{64}`.
 *
 * A digest or organisation id arriving from a caller is never concatenated
 * blindly: a `..`, an extra slash, a NUL or a trailing space would otherwise
 * address an object outside this organisation's prefix.
 */
export function assertBlobObjectKey(key: string): void {
  if (!BLOB_KEY.test(key)) {
    throw new SkillFileStoreError("BLOB_KEY_INVALID");
  }
}

/** The organisation a blob key belongs to, after the key has been asserted. */
export function blobKeyOrganization(key: string): string {
  assertBlobObjectKey(key);
  return BLOB_KEY.exec(key)![1];
}

/** The digest a blob key names, after the key has been asserted. */
export function blobKeyDigest(key: string): string {
  assertBlobObjectKey(key);
  return BLOB_KEY.exec(key)![2];
}

/**
 * The key shapes an object store can be asked to hold.
 *
 * Both shapes put the organisation in the path, which is what makes tenancy
 * structural; they differ only in the segment that says what kind of object it
 * is. A store is constructed with one shape and asserts it on every call, so a
 * digest cannot be written as a skill version or the other way round.
 */
export type ObjectKeyShape = "skill-version" | "blob";

const SKILL_VERSION_KEY =
  /^organizations\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/skill-versions\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/sha256\/[0-9a-f]{64}$/;

/** Asserts `key` belongs to `shape`, refusing every other shape. */
export function assertObjectKey(shape: ObjectKeyShape, key: string): void {
  if (shape === "blob") return assertBlobObjectKey(key);
  if (!SKILL_VERSION_KEY.test(key)) {
    throw new SkillFileStoreError("SKILL_FILE_KEY_INVALID");
  }
}

/**
 * One organisation's blob store.
 *
 * Same digest-verified discipline as the skill store — `putIfAbsent` is
 * idempotent and cannot race a second writer, `read` verifies size and SHA-256
 * before returning a byte — but scoped to a single organisation, so a caller
 * never names another tenant's object and never has to remember to filter.
 *
 * There is deliberately no `list` here. The skill store enumerates with
 * `Prefix: "organizations/"`, i.e. across every tenant, because a reconciler
 * needs that; nothing reachable from a request may. Listing blobs goes through
 * the keyset listing action, which is org-scoped and bound to the caller.
 */
export interface OrganizationBlobStore {
  putIfAbsent(
    organizationId: string,
    sha256: string,
    content: Uint8Array,
  ): Promise<void>;
  read(
    organizationId: string,
    sha256: string,
    expectedSize: number,
  ): Promise<Uint8Array>;
  /**
   * Size of this organization's blob under `sha256`, or null when absent.
   *
   * The caller names a digest, never a path, so there is no call in which a
   * caller supplies a key and therefore none in which it supplies another
   * tenant's.
   */
  stat(
    organizationId: string,
    sha256: string,
  ): Promise<{ sizeBytes: number } | null>;
  recover(
    organizationId: string,
    sha256: string,
    expectedSize: number,
  ): Promise<void>;
}
