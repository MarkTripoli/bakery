import { assert, assertEquals } from "@std/assert";
import {
  defineServerProvider,
  isStoragePath,
  serverProviderDefects,
  StorageChangesPageSchema,
  StorageListPageSchema,
  StorageObjectSchema,
  StoragePathSchema,
  StorageReadInputSchema,
  StorageWriteInputSchema,
  StorageWriteResultSchema,
} from "../../packages/integration-sdk/provider.ts";
import type { ProviderManifest } from "../../packages/integration-sdk/provider.ts";
import { findSchemaDescriptionDefects } from "../../packages/integration-sdk/mod.ts";
import {
  createMemoryStorage,
  fakeDriverContext,
  testManifest,
  testServerImpl,
} from "../../packages/integration-sdk/testing.ts";

const { ctx } = fakeDriverContext();
const decoder = new TextDecoder();

Deno.test("storage paths are absolute and refuse empty, dot and control segments", () => {
  for (const good of ["/", "/a", "/a/b.txt", "/reports/Q3 plan.pdf"]) {
    assert(isStoragePath(good), good);
    assertEquals(StoragePathSchema.safeParse(good).success, true);
  }
  for (const bad of ["", "a", "/a/", "//a", "/a/../b", "/./a", "/a\u0001"]) {
    assertEquals(isStoragePath(bad), false, JSON.stringify(bad));
  }
});

Deno.test("every storage contract schema carries descriptions", () => {
  for (
    const schema of [
      StorageObjectSchema,
      StorageListPageSchema,
      StorageReadInputSchema,
      StorageWriteInputSchema,
      StorageWriteResultSchema,
      StorageChangesPageSchema,
    ]
  ) {
    assertEquals(findSchemaDescriptionDefects(schema), []);
  }
});

Deno.test("the storage family is a manifest family and its port is required when claimed", () => {
  const manifest: ProviderManifest = {
    ...testManifest(),
    families: ["storage"],
  };
  const missing = defineServerProvider(manifest, testServerImpl(manifest));
  assert(
    serverProviderDefects(missing).some((defect) =>
      defect.path === "impl.storage"
    ),
  );
  const storage = createMemoryStorage();
  const supplied = defineServerProvider(
    manifest,
    testServerImpl(manifest, { storage: storage.port }),
  );
  assertEquals(serverProviderDefects(supplied), []);
  const familyless: ProviderManifest = { ...testManifest(), families: [] };
  const smuggled = defineServerProvider(
    familyless,
    testServerImpl(familyless, { storage: storage.port }),
  );
  assert(
    serverProviderDefects(smuggled).some((defect) =>
      defect.path === "impl.storage" && defect.message.includes("must not")
    ),
  );
});

Deno.test("the memory port lists a folder in keyset pages with folders implied", async () => {
  const storage = createMemoryStorage();
  storage.put("/docs/a.txt", "a");
  storage.put("/docs/b.txt", "b");
  storage.put("/docs/deep/c.txt", "c");
  storage.put("/top.txt", "t");
  const root = await storage.port.list({
    path: "/",
    cursor: null,
    limit: 10,
    ctx,
  });
  assertEquals(root.items.map((item) => [item.path, item.kind]), [
    ["/docs", "folder"],
    ["/top.txt", "file"],
  ]);
  const first = await storage.port.list({
    path: "/docs",
    cursor: null,
    limit: 2,
    ctx,
  });
  assertEquals(StorageListPageSchema.safeParse(first).success, true);
  assertEquals(first.items.map((item) => item.name), ["a.txt", "b.txt"]);
  assert(first.nextCursor !== null);
  const second = await storage.port.list({
    path: "/docs",
    cursor: first.nextCursor,
    limit: 2,
    ctx,
  });
  assertEquals(second.items.map((item) => item.name), ["deep"]);
  assertEquals(second.nextCursor, null);
});

Deno.test("the memory port stats, reads a byte range and answers stale for a moved revision", async () => {
  const storage = createMemoryStorage();
  const revision = storage.put("/f.txt", "hello world");
  const stat = await storage.port.stat({ path: "/f.txt", ctx });
  assertEquals(stat?.revision, revision);
  assertEquals(stat?.sizeBytes, 11);
  assertEquals(StorageObjectSchema.safeParse(stat).success, true);
  assertEquals(await storage.port.stat({ path: "/nope", ctx }), null);
  const range = await storage.port.read({
    path: "/f.txt",
    range: { offset: 6, length: 5 },
    revision,
    ctx,
  });
  assert(range.kind === "bytes");
  assertEquals(decoder.decode(range.bytes), "world");
  storage.put("/f.txt", "changed");
  const stale = await storage.port.read({
    path: "/f.txt",
    range: null,
    revision,
    ctx,
  });
  assertEquals(stale.kind, "stale");
  assertEquals(
    (await storage.port.read({
      path: "/gone",
      range: null,
      revision: null,
      ctx,
    }))
      .kind,
    "missing",
  );
});

Deno.test("the memory port writes once per key and refuses a stale If-Match", async () => {
  const storage = createMemoryStorage();
  const bytes = new TextEncoder().encode("out");
  const first = await storage.port.write({
    path: "/out.txt",
    mediaType: "text/plain",
    ifMatch: null,
    idempotencyKey: "k1",
    bytes,
    ctx,
  });
  assert(first.kind === "written");
  const replay = await storage.port.write({
    path: "/out.txt",
    mediaType: "text/plain",
    ifMatch: null,
    idempotencyKey: "k1",
    bytes,
    ctx,
  });
  assertEquals(replay, first);
  const conflict = await storage.port.write({
    path: "/out.txt",
    mediaType: "text/plain",
    ifMatch: null,
    idempotencyKey: "k2",
    bytes,
    ctx,
  });
  assertEquals(conflict.kind, "conflict");
  assertEquals(StorageWriteResultSchema.safeParse(conflict).success, true);
});

Deno.test("the memory port pages its change feed from a position", async () => {
  const storage = createMemoryStorage();
  storage.put("/a", "1");
  storage.put("/a", "2");
  storage.remove("/a");
  const all = await storage.port.changes({ since: null, limit: 2, ctx });
  assertEquals(all.events.map((event) => event.kind), ["created", "updated"]);
  const rest = await storage.port.changes({
    since: all.position,
    limit: 10,
    ctx,
  });
  assertEquals(rest.events.map((event) => event.kind), ["deleted"]);
  assertEquals(StorageChangesPageSchema.safeParse(rest).success, true);
  const empty = await storage.port.changes({
    since: rest.position,
    limit: 10,
    ctx,
  });
  assertEquals(empty.events, []);
  assertEquals(empty.position, rest.position);
});
