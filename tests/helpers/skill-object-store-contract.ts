import { assertEquals, assertRejects } from "@std/assert";
import { createHash } from "node:crypto";
import { skillObjectKey } from "../../apps/server/src/modules/catalog/identity.ts";
import {
  SkillFileStoreError,
  type SkillObjectStore,
} from "../../apps/server/src/modules/catalog/storage-port.ts";

function dropFirstPutResponse(store: SkillObjectStore): SkillObjectStore {
  let drop = true;
  return {
    read: store.read.bind(store),
    recover: store.recover.bind(store),
    list: store.list.bind(store),
    async putIfAbsent(key, bytes, digest) {
      await store.putIfAbsent(key, bytes, digest);
      if (drop) {
        drop = false;
        throw new SkillFileStoreError("SKILL_FILE_DEPENDENCY_UNAVAILABLE");
      }
    },
  };
}

export async function skillObjectStoreContract(
  store: SkillObjectStore,
  replaceStoredBytes: (key: string, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const bytes = new TextEncoder().encode("immutable fixture bytes\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const key = skillObjectKey(crypto.randomUUID(), crypto.randomUUID(), digest);
  const interrupted = dropFirstPutResponse(store);
  await assertRejects(
    () => interrupted.putIfAbsent(key, bytes, digest),
    SkillFileStoreError,
    "SKILL_FILE_DEPENDENCY_UNAVAILABLE",
  );
  assertEquals(await store.read(key, digest, bytes.length), bytes);
  await interrupted.putIfAbsent(key, bytes, digest);
  await Promise.all(
    Array.from({ length: 8 }, () => store.putIfAbsent(key, bytes, digest)),
  );
  await store.recover(key, digest, bytes.length);
  assertEquals(await store.read(key, digest, bytes.length), bytes);
  const inventory = [];
  for await (const object of store.list()) inventory.push(object);
  assertEquals(inventory.filter((item) => item.objectKey === key), [{
    objectKey: key,
    sha256: digest,
    sizeBytes: bytes.length,
  }]);

  // Seed conflicting stored bytes so the valid put reaches conditional creation.
  const replacement = new TextEncoder().encode("different fixture bytes\n");
  const replacementDigest = createHash("sha256").update(replacement).digest(
    "hex",
  );
  await replaceStoredBytes(key, replacement);
  try {
    const error = await assertRejects(
      () => store.putIfAbsent(key, bytes, digest),
      SkillFileStoreError,
    );
    assertEquals(
      [
        "SKILL_OBJECT_DIGEST_CONFLICT",
        "SKILL_CONTENT_INTEGRITY_FAILED",
      ].includes(error.code),
      true,
    );
    assertEquals(
      await store.read(key, replacementDigest, replacement.length),
      replacement,
    );
  } finally {
    await replaceStoredBytes(key, bytes);
  }
  assertEquals(await store.read(key, digest, bytes.length), bytes);
  await assertRejects(() => store.read(key, "0".repeat(64), bytes.length));
  await assertRejects(() => store.read(key, digest, bytes.length + 1));
}
