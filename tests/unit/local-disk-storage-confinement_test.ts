import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import {
  readRuntimeConfig,
  readStorageLocalRootConfig,
} from "../../packages/config/src/env.ts";
import { fakeDriverContext } from "../../packages/integration-sdk/testing.ts";
import {
  createLocalDiskStoragePort,
  createLocalDiskStorageProvider,
  holdsBytes,
  LOCAL_DISK_CHUNK_BYTES,
  LOCAL_DISK_PROVIDER,
  lstatInside,
  namesAfter,
  openInside,
  openStaging,
  readOpened,
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

const nextSecond = () =>
  new Promise((done) => setTimeout(done, 1_050 - Date.now() % 1_000));

const writeNew = (
  port: ReturnType<typeof createLocalDiskStoragePort>,
  path: string,
  ifMatch: string | null = null,
) =>
  port.write({
    path,
    mediaType: "text/plain",
    ifMatch,
    idempotencyKey: "k",
    bytes: encoder.encode("planted"),
    ctx,
  });

Deno.test("a file copied in or restored with an older modified time moves the feed and the revision", () =>
  withRoot(async (_root, folder) => {
    const port = createLocalDiskStoragePort(folder);
    const restored = new Date("2020-01-01T00:00:00Z");
    const copied = new Date("2019-01-01T00:00:00Z");
    await utimes(folder + "/docs/a.txt", restored, restored);
    const before = await port.stat({ path: "/docs/a.txt", ctx });
    const first = await port.changes({ since: null, limit: 50, ctx });
    await nextSecond();
    await writeFile(folder + "/docs/copied.txt", "copied");
    await utimes(folder + "/docs/copied.txt", copied, copied);
    await writeFile(folder + "/docs/a.txt", "omega");
    await utimes(folder + "/docs/a.txt", restored, restored);
    const next = await port.changes({ since: first.position, limit: 50, ctx });
    assertEquals(next.events.map((event) => event.path).sort(), [
      "/docs/a.txt",
      "/docs/copied.txt",
    ]);
    const after = await port.stat({ path: "/docs/a.txt", ctx });
    assertEquals([after?.sizeBytes, after?.modifiedAt], [
      before?.sizeBytes,
      before?.modifiedAt,
    ]);
    assertNotEquals(after?.revision, before?.revision);
  }));

Deno.test("a name over 255 bytes is refused, not an error", () =>
  withRoot(async (_root, folder) => {
    const port = createLocalDiskStoragePort(folder);
    for (const name of ["a".repeat(256), "\u00e9".repeat(128)]) {
      const path = "/docs/" + name;
      assertEquals(await port.stat({ path, ctx }), null);
      assertEquals((await read(port, path)).kind, "missing");
      assertEquals(await port.list({ path, cursor: null, limit: 10, ctx }), {
        items: [],
        nextCursor: null,
      });
      assertEquals(await writeNew(port, path), {
        kind: "conflict",
        current: null,
      });
      assertEquals(await writeNew(port, path + "/inner.txt"), {
        kind: "conflict",
        current: null,
      });
    }
    assertEquals(await readdir(folder + "/docs"), ["a.txt"]);
  }));

Deno.test("a file deleted while its folder is listed or walked is skipped, not an error", () =>
  withRoot(async (_root, folder) => {
    const port = createLocalDiskStoragePort(folder);
    const names = Array.from(
      { length: 100 },
      (_, index) => "f" + String(index).padStart(3, "0") + ".txt",
    );
    for (let round = 0; round < 5; round++) {
      await mkdir(folder + "/many");
      await Promise.all(
        names.map((name) => writeFile(folder + "/many/" + name, "x")),
      );
      const removing = (async () => {
        for (const name of [...names].reverse()) {
          await unlink(folder + "/many/" + name);
        }
      })();
      const [listed, feed] = await Promise.all([
        port.list({ path: "/many", cursor: null, limit: 100, ctx }),
        port.changes({ since: null, limit: 200, ctx }),
        removing,
      ]);
      assert(listed.items.every((item) => names.includes(item.name)));
      assert(
        feed.events.every((event) =>
          event.path === "/docs/a.txt" ||
          names.includes(event.path.slice("/many/".length))
        ),
      );
      await Deno.remove(folder + "/many", { recursive: true });
    }
  }));

Deno.test("a symbolic link inside the folder is not followed for stat, read, list or write", () =>
  withRoot(async (_root, folder) => {
    await symlink(folder + "/docs/a.txt", folder + "/docs/alias.txt");
    await symlink(folder + "/docs", folder + "/mirror");
    const port = createLocalDiskStoragePort(folder);
    for (const path of ["/docs/alias.txt", "/mirror/a.txt", "/mirror"]) {
      assertEquals(await port.stat({ path, ctx }), null, path);
      assertEquals((await read(port, path)).kind, "missing", path);
    }
    assertEquals(
      await port.list({ path: "/mirror", cursor: null, limit: 10, ctx }),
      { items: [], nextCursor: null },
    );
    const revision = (await port.stat({ path: "/docs/a.txt", ctx }))!.revision;
    assertEquals(await writeNew(port, "/mirror/new.txt"), {
      kind: "conflict",
      current: null,
    });
    assertEquals(await writeNew(port, "/mirror/a.txt", revision), {
      kind: "conflict",
      current: null,
    });
    assertEquals(await writeNew(port, "/docs/alias.txt"), {
      kind: "conflict",
      current: null,
    });
    assertEquals(await writeNew(port, "/docs/alias.txt", revision), {
      kind: "conflict",
      current: null,
    });
    assertEquals(await readFile(folder + "/docs/a.txt", "utf8"), "alpha");
    assertEquals((await readdir(folder + "/docs")).sort(), [
      "a.txt",
      "alias.txt",
    ]);
    assert((await lstat(folder + "/docs/alias.txt")).isSymbolicLink());
  }));

Deno.test("a folder swapped for a link around the walk is refused for read and write", () =>
  withRoot(async (_root, folder, outside) => {
    const base = await realpath(folder);
    await writeFile(outside + "/a.txt", "secret");
    const walked = await lstatInside(base, "/docs/a.txt");
    assert(walked !== null);
    const opened = await openInside(base, "/docs/a.txt", walked);
    assert(opened !== null);
    await opened.handle.close();
    await rename(folder + "/docs", folder + "/kept");
    await symlink(outside, folder + "/docs");
    assertEquals(await openInside(base, "/docs/a.txt", walked), null);
    const raced = await lstat(outside + "/a.txt", { bigint: true });
    assertEquals(await openInside(base, "/docs/a.txt", raced), null);
    assertEquals(await lstatInside(base, "/docs/a.txt"), null);
    assertEquals(await openStaging(base, "/docs/new.txt"), null);
    const port = createLocalDiskStoragePort(folder);
    assertEquals((await read(port, "/docs/a.txt")).kind, "missing");
    assertEquals(await writeNew(port, "/docs/new.txt"), {
      kind: "conflict",
      current: null,
    });
    assertEquals((await readdir(outside)).sort(), ["a.txt", "secret.txt"]);
  }));

Deno.test("a file rewritten in place after it was opened answers stale, not bytes under the old revision", () =>
  withRoot(async (_root, folder) => {
    const base = await realpath(folder);
    const walked = await lstatInside(base, "/docs/a.txt");
    assert(walked !== null);
    const file = await openInside(base, "/docs/a.txt", walked);
    assert(file !== null);
    try {
      const fresh = await readOpened("/docs/a.txt", file, {
        range: null,
        revision: null,
      });
      assert(fresh.kind === "bytes");
      assertEquals(decoder.decode(fresh.bytes), "alpha");
      await writeFile(folder + "/docs/a.txt", "alpha, rewritten in place");
      const moved = await readOpened("/docs/a.txt", file, {
        range: null,
        revision: null,
      });
      assert(moved.kind === "stale");
      assertEquals(moved.current.sizeBytes, 25);
      assertNotEquals(moved.current.revision, fresh.object.revision);
    } finally {
      await file.handle.close();
    }
  }));

Deno.test("an unchanged rewrite is compared by size, then in bounded chunks", () =>
  withRoot(async (_root, folder) => {
    const base = await realpath(folder);
    const big = Uint8Array.from(
      { length: 3 * LOCAL_DISK_CHUNK_BYTES + 17 },
      (_, index) => index % 251,
    );
    const flipped = big.slice();
    flipped[flipped.length - 1] ^= 1;
    await writeFile(folder + "/docs/big.bin", big);
    const walked = await lstatInside(base, "/docs/big.bin");
    assert(walked !== null);
    const file = await openInside(base, "/docs/big.bin", walked);
    assert(file !== null);
    const lengths: number[] = [];
    const counted = {
      read: (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) => {
        lengths.push(length);
        return file.handle.read(buffer, offset, length, position);
      },
    };
    try {
      assertEquals(
        await holdsBytes(counted, file.stats.size, big.subarray(1)),
        false,
      );
      assertEquals(lengths, []);
      assertEquals(await holdsBytes(counted, file.stats.size, big), true);
      assertEquals(lengths.length, 4);
      assert(lengths.every((length) => length <= LOCAL_DISK_CHUNK_BYTES));
      assertEquals(await holdsBytes(counted, file.stats.size, flipped), false);
    } finally {
      await file.handle.close();
    }
    const port = createLocalDiskStoragePort(folder);
    const rewrite = (bytes: Uint8Array) =>
      port.write({
        path: "/docs/big.bin",
        mediaType: "application/octet-stream",
        ifMatch: "0-0-0",
        idempotencyKey: "k",
        bytes,
        ctx,
      });
    assertEquals((await rewrite(big)).kind, "written");
    assertEquals((await rewrite(flipped)).kind, "conflict");
  }));

Deno.test("a folder page keeps only the names it needs, in order, across pages", () =>
  withRoot(async (_root, folder) => {
    const names = Array.from(
      { length: 250 },
      (_, index) => "n" + String(index).padStart(3, "0") + ".txt",
    );
    await mkdir(folder + "/wide");
    await Promise.all(
      names.map((name) => writeFile(folder + "/wide/" + name, "x")),
    );
    await writeFile(folder + "/wide/.bakery-write-staged", "staged");
    await symlink(folder + "/docs/a.txt", folder + "/wide/link.txt");
    const base = await realpath(folder);
    assertEquals(await namesAfter(base + "/wide", null, 3), names.slice(0, 3));
    assertEquals(
      await namesAfter(base + "/wide", "n247.txt", 5),
      names.slice(248),
    );
    const port = createLocalDiskStoragePort(folder);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof port.list>> = await port.list({
        path: "/wide",
        cursor,
        limit: 7,
        ctx,
      });
      assert(page.items.length <= 7);
      seen.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assertEquals(seen, names);
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
