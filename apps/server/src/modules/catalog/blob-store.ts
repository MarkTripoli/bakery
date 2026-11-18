import {
  blobObjectKey,
  type OrganizationBlobStore,
  type SkillObjectStore,
} from "./storage-port.ts";

/**
 * Presents the shipped object store as one organisation's blob store.
 *
 * The bytes-level discipline is not reimplemented: every call is delegated to
 * the store that already verifies size and SHA-256 on read and refuses a second
 * writer of the same key. What this adapter adds is the part a blob caller must
 * never be trusted with — the key itself. A caller names an organisation and a
 * digest; the key is built here, so there is no call in which a caller supplies
 * a path, and therefore no call in which a caller can supply another tenant's.
 *
 * An organisation id or digest that would build a key outside the
 * organisation's prefix is refused by `blobObjectKey` before any store call.
 */
export class ScopedOrganizationBlobStore implements OrganizationBlobStore {
  // Only these three calls are ever made, so the adapter does not demand a
  // `list()` a blob store has no business having.
  constructor(
    private readonly store: Pick<
      SkillObjectStore,
      "putIfAbsent" | "read" | "recover" | "stat"
    >,
  ) {}

  async putIfAbsent(
    organizationId: string,
    sha256: string,
    content: Uint8Array,
  ): Promise<void> {
    await this.store.putIfAbsent(
      blobObjectKey(organizationId, sha256),
      content,
      sha256,
    );
  }

  async read(
    organizationId: string,
    sha256: string,
    expectedSize: number,
  ): Promise<Uint8Array> {
    return await this.store.read(
      blobObjectKey(organizationId, sha256),
      sha256,
      expectedSize,
    );
  }

  async stat(
    organizationId: string,
    sha256: string,
  ): Promise<{ sizeBytes: number } | null> {
    return await this.store.stat(blobObjectKey(organizationId, sha256));
  }

  async recover(
    organizationId: string,
    sha256: string,
    expectedSize: number,
  ): Promise<void> {
    await this.store.recover(
      blobObjectKey(organizationId, sha256),
      sha256,
      expectedSize,
    );
  }
}
