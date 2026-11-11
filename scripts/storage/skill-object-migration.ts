import type { Database } from "../../packages/persistence/src/postgres.ts";
import { withApplicationDatabaseDrain } from "../../apps/server/src/platform/data-migrate.ts";
import type {
  SkillObject,
  SkillObjectStore,
} from "../../apps/server/src/modules/catalog/storage-port.ts";
import {
  assertSkillObjectKey,
  SkillFileStoreError,
} from "../../apps/server/src/modules/catalog/storage-port.ts";
import { z } from "zod";

export const SkillInventorySchema = z.array(
  z.object({
    objectKey: z.string().describe(
      "Exact logical immutable object key shared by both storage adapters.",
    ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).describe(
      "SHA-256 of the bytes recovered from this key.",
    ),
    sizeBytes: z.number().int().min(0).max(10 * 1024 * 1024).describe(
      "Exact byte length verified before this inventory was written.",
    ),
  }).strict().describe(
    "One immutable skill object verified for a storage migration.",
  ),
).describe(
  "Complete immutable skill object inventory, including unpublished objects retained for retry.",
);

export async function verifySkillInventory(
  store: SkillObjectStore,
  inventory: readonly SkillObject[],
): Promise<void> {
  const keys = new Set<string>();
  for (const object of inventory) {
    assertSkillObjectKey(object.objectKey);
    if (
      keys.has(object.objectKey) ||
      object.objectKey.slice(-64) !== object.sha256
    ) throw new SkillFileStoreError("SKILL_CONTENT_INTEGRITY_FAILED");
    keys.add(object.objectKey);
    await store.read(object.objectKey, object.sha256, object.sizeBytes);
  }
}

export async function collectSkillInventory(
  store: SkillObjectStore,
): Promise<SkillObject[]> {
  const inventory: SkillObject[] = [];
  for await (const object of store.list()) inventory.push(object);
  inventory.sort((a, b) => a.objectKey.localeCompare(b.objectKey));
  await verifySkillInventory(store, inventory);
  return inventory;
}

export async function copySkillInventory(
  source: SkillObjectStore,
  target: SkillObjectStore,
  inventory: readonly SkillObject[],
): Promise<void> {
  await verifySkillInventory(source, inventory);
  for (const object of inventory) {
    const content = await source.read(
      object.objectKey,
      object.sha256,
      object.sizeBytes,
    );
    await target.putIfAbsent(object.objectKey, content, object.sha256);
    await target.read(object.objectKey, object.sha256, object.sizeBytes);
  }
}

export async function withSkillStoragePause<T>(
  database: Database,
  operation: () => Promise<T>,
): Promise<T> {
  const owners = await database<
    { owner: boolean }[]
  >`select current_user = pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()`;
  if (!owners[0]?.owner) throw new Error("SKILL_STORAGE_OWNER_REQUIRED");
  return await withApplicationDatabaseDrain(database, operation);
}

export async function assertReferencedInventory(
  database: Database,
  inventory: readonly SkillObject[],
): Promise<void> {
  const references = await database<
    { object_key: string; sha256: string; size_bytes: number }[]
  >`select distinct object_key, sha256, size_bytes from bakery.skill_files`;
  const objects = new Map(
    inventory.map((object) => [object.objectKey, object]),
  );
  for (const reference of references) {
    const object = objects.get(reference.object_key);
    if (
      !object || object.sha256 !== reference.sha256 ||
      object.sizeBytes !== Number(reference.size_bytes)
    ) throw new Error("SKILL_STORAGE_INVENTORY_INCOMPLETE");
  }
}
