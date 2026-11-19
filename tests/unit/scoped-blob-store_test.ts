import { assert, assertEquals, assertRejects } from "@std/assert";
import { ScopedOrganizationBlobStore } from "../../apps/server/src/modules/catalog/blob-store.ts";
import {
  blobObjectKey,
  SkillFileStoreError,
  type SkillObject,
  type SkillObjectStore,
} from "../../apps/server/src/modules/catalog/storage-port.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const BYTES = new TextEncoder().encode("blob content");

/** Records every call so the test can assert the key the store was given. */
function recordingStore(): {
  readonly store: SkillObjectStore;
  readonly calls: { op: string; key: string; digest: string }[];
} {
  const calls: { op: string; key: string; digest: string }[] = [];
  const store: SkillObjectStore = {
    putIfAbsent(key, _content, digest) {
      calls.push({ op: "putIfAbsent", key, digest });
      return Promise.resolve();
    },
    read(key, digest) {
      calls.push({ op: "read", key, digest });
      return Promise.resolve(BYTES);
    },
    recover(key, digest) {
      calls.push({ op: "recover", key, digest });
      return Promise.resolve();
    },
    stat(key) {
      calls.push({ op: "stat", key, digest: "" });
      return Promise.resolve({ sizeBytes: BYTES.length });
    },
    delete(key) {
      calls.push({ op: "delete", key, digest: "" });
      return Promise.resolve(true);
    },
    list(): AsyncIterable<SkillObject> {
      throw new Error("a request path must never enumerate across tenants");
    },
  };
  return { store, calls };
}

Deno.test("every call addresses the organisation's own prefix", async () => {
  const { store, calls } = recordingStore();
  const blobs = new ScopedOrganizationBlobStore(store);

  await blobs.putIfAbsent(ORG, DIGEST, BYTES);
  await blobs.read(ORG, DIGEST, BYTES.length);
  await blobs.recover(ORG, DIGEST, BYTES.length);

  assertEquals(calls.map((call) => call.op), [
    "putIfAbsent",
    "read",
    "recover",
  ]);
  // The caller names a tenant and a digest, never a path; the key is built
  // here, so there is no call in which a caller can supply another tenant's.
  for (const call of calls) {
    assertEquals(call.key, blobObjectKey(ORG, DIGEST));
    assertEquals(call.digest, DIGEST);
  }
});

Deno.test("the same digest under two organisations is two objects", async () => {
  const { store, calls } = recordingStore();
  const blobs = new ScopedOrganizationBlobStore(store);

  await blobs.putIfAbsent(ORG, DIGEST, BYTES);
  await blobs.putIfAbsent(OTHER_ORG, DIGEST, BYTES);

  // Identical bytes, identical digest, two keys: deduplication happens inside
  // an organisation and never across one (O43).
  assert(
    calls[0].key !== calls[1].key,
    "the two writes must not share an object",
  );
});

Deno.test("an organisation that would escape its prefix is refused before the store", async () => {
  const { store, calls } = recordingStore();
  const blobs = new ScopedOrganizationBlobStore(store);

  for (const org of ["..", `${ORG}/../${OTHER_ORG}`, "", "org"]) {
    await assertRejects(
      () => blobs.putIfAbsent(org, DIGEST, BYTES),
      SkillFileStoreError,
    );
  }
  // Nothing reached the store, so nothing could write outside the prefix.
  assertEquals(calls, []);
});

Deno.test("a malformed digest is refused before the store", async () => {
  const { store, calls } = recordingStore();
  const blobs = new ScopedOrganizationBlobStore(store);

  for (const digest of ["", "a".repeat(63), "A".repeat(64), `${DIGEST}x`]) {
    await assertRejects(
      () => blobs.read(ORG, digest, BYTES.length),
      SkillFileStoreError,
    );
  }
  assertEquals(calls, []);
});

Deno.test("the blob store offers no way to enumerate across tenants", () => {
  const { store } = recordingStore();
  const blobs: object = new ScopedOrganizationBlobStore(store);
  // A reconciler needs list(); a request path must not have one. The port
  // carries no list at all, so no org-scoped action can reach the one that
  // enumerates `organizations/` across every tenant.
  assertEquals("list" in blobs, false);
});
