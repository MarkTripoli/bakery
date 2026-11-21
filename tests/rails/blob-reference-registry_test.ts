import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  blobReferenceKinds,
  collectableBlobQuery,
  liveBlobReferenceQuery,
} from "../../apps/server/src/modules/knowledge/blob-references.ts";

/**
 * Every foreign key to `bakery.blobs` must be on the collector's registry.
 *
 * Collection deletes a blob row and then its bytes, and the row delete is the
 * only moment a foreign key gets a say. A table that names a blob but is not on
 * the registry is therefore not merely unprotected: the delete fails with
 * `on delete restrict`, or worse, `set null` quietly drops the reference and the
 * bytes go with it while a live row still expects them.
 *
 * This rail reads the migrations rather than the code, so it sees a table the
 * day its migration lands, in whichever pull request that is. A new reference
 * fails here until it is registered, which is the whole point: the registry is
 * the one list, and it cannot fall behind the schema.
 */

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);

type ForeignKey = Readonly<{
  file: string;
  table: string;
  constraint: string;
  column: string;
}>;

/** Every `.sql` file under every module's `migrations` directory. */
async function migrationFiles(): Promise<readonly string[]> {
  const files: string[] = [];
  const walk = async (path: string) => {
    for await (const entry of Deno.readDir(path)) {
      const full = `${path}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "node_modules") continue;
        await walk(full);
      } else if (entry.name.endsWith(".sql")) {
        files.push(full);
      }
    }
  };
  await walk(`${root}apps/server/src`);
  return files.sort();
}

/**
 * The table a constraint belongs to: the nearest `create table` or
 * `alter table` before the constraint in the same file.
 */
function tableFor(source: string, index: number): string {
  const before = source.slice(0, index);
  const matches = [...before.matchAll(
    /(?:create|alter) table (?:if not exists )?bakery\.([a-z_]+)/gi,
  )];
  return matches.length === 0 ? "" : matches[matches.length - 1][1];
}

/** Foreign keys in one migration file that point at `bakery.blobs`. */
function blobForeignKeys(file: string, source: string): readonly ForeignKey[] {
  const pattern =
    /constraint\s+([a-z_]+)\s+foreign key\s*\(([^)]*)\)\s*references\s+bakery\.blobs\b/gi;
  const found: ForeignKey[] = [];
  for (const match of source.matchAll(pattern)) {
    const columns = match[2].split(",").map((column) => column.trim());
    // `(organization_id, id)` is the tenant-scoped reference shape the schema
    // uses; the blob column is the one that is not the organization.
    const column = columns.find((name) => name !== "organization_id") ?? "";
    found.push({
      file: file.slice(root.length),
      table: tableFor(source, match.index ?? 0),
      constraint: match[1],
      column,
    });
  }
  return found;
}

Deno.test("every foreign key to bakery.blobs is on the collector's registry", async () => {
  const files = await migrationFiles();
  const foreignKeys: ForeignKey[] = [];
  for (const file of files) {
    foreignKeys.push(...blobForeignKeys(file, await Deno.readTextFile(file)));
  }
  // The two the schema has today. A run that finds none would pass this test
  // without checking anything, so the count is asserted too.
  assert(
    foreignKeys.length >= 2,
    `expected at least the artifact and upload-session references, found ${foreignKeys.length}`,
  );

  const registered = new Set(
    blobReferenceKinds.map((kind) => `${kind.table}.${kind.column}`),
  );
  for (const key of foreignKeys) {
    assert(
      registered.has(`${key.table}.${key.column}`),
      `${key.file}: ${key.table}.${key.column} (${key.constraint}) references bakery.blobs but is not on blobReferenceKinds, so collection can delete bytes it still needs`,
    );
  }
});

Deno.test("the registry names a constraint the schema actually declares", async () => {
  const files = await migrationFiles();
  const declared = new Set<string>();
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    for (const key of blobForeignKeys(file, source)) {
      declared.add(key.constraint);
    }
  }
  for (const kind of blobReferenceKinds) {
    // A digest-named reference rides on no foreign key: an upload names bytes it
    // has not stored yet, so there is no row to point at.
    if (kind.constraint === null) continue;
    // A stale entry is as dangerous as a missing one in the other direction: it
    // makes the collector ask a table that no longer exists, and the existence
    // query throws instead of answering.
    assert(
      declared.has(kind.constraint),
      `blobReferenceKinds names ${kind.constraint}, and no migration declares it`,
    );
  }
});

Deno.test("both queries ask every registered table, and none when the list is empty", () => {
  const live = liveBlobReferenceQuery(blobReferenceKinds);
  const candidates = collectableBlobQuery(blobReferenceKinds);
  for (const kind of blobReferenceKinds) {
    // The point of one list is that no caller can check a subset: both the
    // existence check and the sweep's candidate scan must name every table.
    assert(live.includes(`bakery.${kind.table}`), live);
    assert(live.includes(kind.liveCondition), live);
    assert(candidates.includes(`bakery.${kind.table}`), candidates);
    assert(candidates.includes(kind.liveCondition), candidates);
  }
  // An empty registry would answer "nothing references this" for every blob,
  // which is a delete nobody approved. It has to throw, not return a query.
  assertThrows(() => liveBlobReferenceQuery([]), TypeError);
  assertThrows(() => collectableBlobQuery([]), TypeError);
});

Deno.test("no reference is registered twice", () => {
  const keys = blobReferenceKinds.map((kind) => `${kind.table}.${kind.column}`);
  assertEquals(new Set(keys).size, keys.length);
});
