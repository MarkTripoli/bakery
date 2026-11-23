import { assert, assertEquals, assertThrows } from "@std/assert";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import {
  readRuntimeConfig,
  readStorageLocalRootConfig,
} from "../../packages/config/src/env.ts";
import { fakeDriverContext } from "../../packages/integration-sdk/testing.ts";
import {
  createLocalDiskStoragePort,
  createLocalDiskStorageProvider,
  LOCAL_DISK_PROVIDER,
} from "../../apps/server/src/modules/knowledge/local-disk-storage.ts";
import {
  defaultStorageConnections,
  deployedStorageProviders,
} from "../../apps/server/src/modules/knowledge/storage-connections.ts";

const { ctx } = fakeDriverContext();
const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function withRoot(
  work: (root: string, folder: string, outside: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "bakery-local-disk-" });
  const outside = await Deno.makeTempDir({ prefix: "bakery-outside-" });
  try {
    const folder = root + "/conn";
    await mkdir(folder + "/docs", { recursive: true });
    await writeFile(folder + "/docs/a.txt", "alpha");
    await writeFile(outside + "/secret.txt", "secret");
    await writeFile(root + "/sibling.txt", "sibling");
    await work(root, folder, outside);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
}

const read = (
  port: ReturnType<typeof createLocalDiskStoragePort>,
  path: string,
) => port.read({ path, range: null, revision: null, ctx });

Deno.test("a .. or relative path never leaves the connection folder", () =>
  withRoot(async (_root, folder) => {
    const port = createLocalDiskStoragePort(folder);
    for (
      const path of [
        "/../sibling.txt",
        "/docs/../../sibling.txt",
        "../sibling.txt",
        "docs/a.txt",
        "/docs/./a.txt",
        "/docs//a.txt",
      ]
    ) {
      assertEquals(await port.stat({ path, ctx }), null, path);
      assertEquals((await read(port, path)).kind, "missing", path);
      assertEquals(
        await port.list({ path, cursor: null, limit: 10, ctx }),
        { items: [], nextCursor: null },
        path,
      );
    }
    const written = await port.write({
      path: "/../escape.txt",
      mediaType: "text/plain",
      ifMatch: null,
      idempotencyKey: "k",
      bytes: encoder.encode("x"),
      ctx,
    });
    assertEquals(written, { kind: "conflict", current: null });
    assertEquals((await read(port, "/docs/a.txt")).kind, "bytes");
  }));

Deno.test("an absolute host path is read inside the folder, not on the host", () =>
  withRoot(async (_root, folder, outside) => {
    const port = createLocalDiskStoragePort(folder);
    assertEquals(await port.stat({ path: outside + "/secret.txt", ctx }), null);
    assertEquals((await read(port, outside + "/secret.txt")).kind, "missing");
    assertEquals(await port.stat({ path: "/etc/passwd", ctx }), null);
  }));

Deno.test("a symbolic link that leaves the folder is neither listed nor followed", () =>
  withRoot(async (_root, folder, outside) => {
    await symlink(outside + "/secret.txt", folder + "/docs/link.txt");
    await symlink(outside, folder + "/docs/linkdir");
    await symlink(outside, folder + "/out");
    const port = createLocalDiskStoragePort(folder);
    const listed = await port.list({
      path: "/docs",
      cursor: null,
      limit: 10,
      ctx,
    });
    assertEquals(listed.items.map((item) => item.name), ["a.txt"]);
    for (
      const path of [
        "/docs/link.txt",
        "/docs/linkdir/secret.txt",
        "/out/secret.txt",
      ]
    ) {
      assertEquals(await port.stat({ path, ctx }), null, path);
      assertEquals((await read(port, path)).kind, "missing", path);
    }
    assertEquals(
      await port.list({ path: "/docs/linkdir", cursor: null, limit: 10, ctx }),
      { items: [], nextCursor: null },
    );
    const written = await port.write({
      path: "/out/planted.txt",
      mediaType: "text/plain",
      ifMatch: null,
      idempotencyKey: "k",
      bytes: encoder.encode("x"),
      ctx,
    });
    assertEquals(written, { kind: "conflict", current: null });
    assertEquals(
      await Deno.stat(outside + "/planted.txt").then(() => true, () => false),
      false,
    );
    const feed = await port.changes({ since: null, limit: 50, ctx });
    assertEquals(feed.events.map((event) => event.path), ["/docs/a.txt"]);
    const swapped = createLocalDiskStoragePort(folder, ["docs", "linkdir"]);
    assertEquals(await swapped.stat({ path: "/secret.txt", ctx }), null);
  }));

Deno.test("list, stat, range read, write and changes answer inside the folder", () =>
  withRoot(async (_root, folder) => {
    const port = createLocalDiskStoragePort(folder);
    await writeFile(folder + "/docs/b.txt", "bravo");
    await mkdir(folder + "/docs/deep");
    const first = await port.list({
      path: "/docs",
      cursor: null,
      limit: 2,
      ctx,
    });
    assertEquals(first.items.map((item) => item.path), [
      "/docs/a.txt",
      "/docs/b.txt",
    ]);
    assert(first.nextCursor !== null);
    const rest = await port.list({
      path: "/docs",
      cursor: first.nextCursor,
      limit: 2,
      ctx,
    });
    assertEquals(rest.items.map((item) => [item.name, item.kind]), [[
      "deep",
      "folder",
    ]]);
    assertEquals(rest.nextCursor, null);

    const stat = await port.stat({ path: "/docs/b.txt", ctx });
    assertEquals([stat?.kind, stat?.sizeBytes, stat?.mediaType], [
      "file",
      5,
      "text/plain",
    ]);
    const range = await port.read({
      path: "/docs/b.txt",
      range: { offset: 1, length: 3 },
      revision: stat!.revision,
      ctx,
    });
    assert(range.kind === "bytes");
    assertEquals(decoder.decode(range.bytes), "rav");

    const created = await port.write({
      path: "/out/new/report.txt",
      mediaType: "text/plain",
      ifMatch: null,
      idempotencyKey: "k1",
      bytes: encoder.encode("one"),
      ctx,
    });
    assert(created.kind === "written");
    assertEquals(await readFile(folder + "/out/new/report.txt", "utf8"), "one");
    const repeated = await port.write({
      path: "/out/new/report.txt",
      mediaType: "text/plain",
      ifMatch: null,
      idempotencyKey: "k1",
      bytes: encoder.encode("one"),
      ctx,
    });
    assertEquals(repeated.kind, "written");
    const clash = await port.write({
      path: "/out/new/report.txt",
      mediaType: "text/plain",
      ifMatch: null,
      idempotencyKey: "k2",
      bytes: encoder.encode("two"),
      ctx,
    });
    assertEquals(clash.kind, "conflict");
    const replaced = await port.write({
      path: "/out/new/report.txt",
      mediaType: "text/plain",
      ifMatch: created.object.revision,
      idempotencyKey: "k3",
      bytes: encoder.encode("three"),
      ctx,
    });
    assert(replaced.kind === "written");
    assert(replaced.object.revision !== created.object.revision);
    const stale = await port.read({
      path: "/out/new/report.txt",
      range: null,
      revision: created.object.revision,
      ctx,
    });
    assertEquals(stale.kind, "stale");
    const out = await port.list({
      path: "/out/new",
      cursor: null,
      limit: 10,
      ctx,
    });
    assertEquals(out.items.map((item) => item.name), ["report.txt"]);

    const all = await port.changes({ since: null, limit: 50, ctx });
    assertEquals(
      all.events.map((event) => event.path).sort(),
      ["/docs/a.txt", "/docs/b.txt", "/out/new/report.txt"],
    );
    const quiet = await port.changes({ since: all.position, limit: 50, ctx });
    assertEquals([quiet.events.length, quiet.position], [0, all.position]);
    const paged = await port.changes({ since: null, limit: 1, ctx });
    assertEquals(paged.events.length, 1);
    const next = await port.changes({ since: paged.position, limit: 50, ctx });
    assertEquals(next.events.length, 2);
  }));

Deno.test("the provider binds each connection to its own folder under the root", () =>
  withRoot(async (root, _folder, outside) => {
    const organizationId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const folder = `${root}/${organizationId}/${connectionId}`;
    await mkdir(folder, { recursive: true });
    await writeFile(folder + "/mine.txt", "mine");
    const entry = createLocalDiskStorageProvider(root + "/");
    assertEquals(entry.provider, LOCAL_DISK_PROVIDER);
    const binding = entry.bind({
      id: connectionId,
      organizationId,
      provider: LOCAL_DISK_PROVIDER,
    });
    assert(binding !== undefined);
    assertEquals(
      (await binding.port.stat({ path: "/mine.txt", ctx: binding.ctx }))
        ?.sizeBytes,
      4,
    );
    const other = entry.bind({
      id: crypto.randomUUID(),
      organizationId,
      provider: LOCAL_DISK_PROVIDER,
    })!;
    assertEquals(
      await other.port.stat({ path: "/mine.txt", ctx: other.ctx }),
      null,
    );
    const planted = crypto.randomUUID();
    const plantedConnection = crypto.randomUUID();
    await mkdir(outside + "/" + plantedConnection);
    await writeFile(outside + "/" + plantedConnection + "/secret.txt", "s");
    await symlink(outside, root + "/" + planted);
    const leak = entry.bind({
      id: plantedConnection,
      organizationId: planted,
      provider: LOCAL_DISK_PROVIDER,
    })!;
    assertEquals(
      await leak.port.stat({ path: "/secret.txt", ctx: leak.ctx }),
      null,
    );
    assertEquals(
      entry.bind({
        id: "../..",
        organizationId,
        provider: LOCAL_DISK_PROVIDER,
      }),
      undefined,
    );
    assertEquals(
      entry.bind({
        id: connectionId,
        organizationId: "..",
        provider: LOCAL_DISK_PROVIDER,
      }),
      undefined,
    );
    assertThrows(
      () => createLocalDiskStorageProvider("relative"),
      Error,
      "STORAGE_LOCAL_ROOT_INVALID",
    );

    assertEquals(deployedStorageProviders().length, 0);
    assertEquals(
      deployedStorageProviders({ storageLocalRoot: root }).map((p) =>
        p.provider
      ),
      [LOCAL_DISK_PROVIDER],
    );
    const deps = defaultStorageConnections({ storageLocalRoot: root });
    assert(
      deps.resolver({
        id: connectionId,
        organizationId,
        provider: LOCAL_DISK_PROVIDER,
      }) !== undefined,
    );
    assertEquals(
      deps.resolver({ id: connectionId, organizationId, provider: "github" }),
      undefined,
    );
    assertEquals(
      defaultStorageConnections().resolver({
        id: connectionId,
        organizationId,
        provider: LOCAL_DISK_PROVIDER,
      }),
      undefined,
    );
  }));

Deno.test("BAKERY_STORAGE_LOCAL_ROOT is read through RuntimeConfig and fails closed", () => {
  assertEquals(readStorageLocalRootConfig(undefined), undefined);
  assertEquals(readStorageLocalRootConfig("  "), undefined);
  assertEquals(readStorageLocalRootConfig("/srv/bakery/storage"), {
    root: "/srv/bakery/storage",
  });
  assertThrows(
    () => readStorageLocalRootConfig("srv/storage"),
    Error,
    "STORAGE_LOCAL_ROOT_INVALID",
  );
  assertThrows(
    () => readStorageLocalRootConfig("/srv/\u0000x"),
    Error,
    "STORAGE_LOCAL_ROOT_INVALID",
  );
  const server = readRuntimeConfig({
    BAKERY_ENVIRONMENT: "test",
    BAKERY_STORAGE_LOCAL_ROOT: "/srv/s",
  }, "server");
  assertEquals(server.storageLocalRoot, { root: "/srv/s" });
  const bad = readRuntimeConfig({
    BAKERY_ENVIRONMENT: "test",
    BAKERY_STORAGE_LOCAL_ROOT: "rel",
  }, "server");
  assertEquals(bad.storageLocalRoot, undefined);
  assertEquals(bad.invalidConfig.includes("BAKERY_STORAGE_LOCAL_ROOT"), true);
});
