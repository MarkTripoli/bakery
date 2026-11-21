/**
 * The advisory lock key that covers one object in the blob store.
 *
 * Artifact bytes, upload completions and plugin bundles all live at
 * `organizations/{org}/blobs/sha256/{digest}`, and that key is shared by
 * everything in the tenant with identical bytes. So the lock has to be named
 * after the object and not after the row that happens to be collected or
 * written: a collector deleting a withdrawn plugin's archive and an upload
 * completing for the same bytes must contend for one lock, or one of them
 * loses data the other still needs.
 *
 * Every writer and deleter of these bytes takes it, in one transaction, across
 * its write or delete. Keying it by the tenant as well as the object ref keeps
 * two organizations from ever sharing a lock.
 */
export function blobKeyLock(organizationId: string, objectRef: string): string {
  return `${organizationId}:${objectRef}`;
}
