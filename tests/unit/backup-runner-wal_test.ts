import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  BASE_BACKUP_FILE,
  earliestBaseBackup,
  shipWal,
  WAL_UNBROKEN_SINCE_FILE,
  walKey,
  type WalShipDeps,
  walUnbrokenSince,
} from "../../scripts/deploy/backup-runner/wal.ts";
import type { Connection } from "../../scripts/deploy/backup-runner/offsite.ts";

const SEG1 = "000000010000000000000041";
const SEG2 = "000000010000000000000042";

async function spoolWith(names: string[]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-wal-spool-" });
  for (const [index, name] of names.entries()) {
    const path = join(dir, name);
    await Deno.writeTextFile(path, "wal " + name);
    const at = new Date(Date.UTC(2026, 10, 21, 10, index));
    await Deno.utime(path, at, at);
  }
  return dir;
}

function fakeConnection(failOn?: string) {
  const puts: string[] = [];
  const connection = {
    client: {
      send: (command: { input: { Key: string } }) => {
        if (failOn && command.input.Key.includes(failOn)) {
          return Promise.reject(new Error("destination refused"));
        }
        puts.push(command.input.Key);
        return Promise.resolve({});
      },
    },
    destination: { bucket: "b", prefix: "prod/" },
  } as unknown as Connection;
  return { connection, puts };
}

const base = (over: Partial<WalShipDeps>, spool: string): WalShipDeps => ({
  spool,
  enabled: true,
  connection: null,
  encrypt: (path) => Promise.resolve(new TextEncoder().encode("age:" + path)),
  report: () => Promise.resolve(),
  earliestBaseBackupAt: new Date("2026-11-20T03:00:00Z"),
  ...over,
});

Deno.test("on, every archived file is shipped oldest first, removed after upload, and the window reported", async () => {
  const spool = await spoolWith([SEG2, SEG1, "00000002.history", "stray.tmp"]);
  const { connection, puts } = fakeConnection();
  const reports: unknown[] = [];
  const outcome = await shipWal(base({
    connection,
    report: (window) => {
      reports.push(window);
      return Promise.resolve();
    },
  }, spool));
  assertEquals(outcome, { shipped: 3, pruned: 0, reported: true });
  assertEquals(puts, [
    walKey("prod/", SEG1),
    walKey("prod/", SEG2),
    walKey("prod/", "00000002.history"),
  ]);
  assertEquals(reports, [{
    latestArchivedAt: "2026-11-21T10:00:00.000Z",
    earliestBaseBackupAt: "2026-11-20T03:00:00.000Z",
    latestSegment: SEG2,
  }]);
  const left = [...Deno.readDirSync(spool)].map((e) => e.name);
  assertEquals(left, ["stray.tmp"]);
});

Deno.test("a failed upload keeps that file and every later one for the next pass", async () => {
  const spool = await spoolWith([SEG1, SEG2]);
  const { connection } = fakeConnection(SEG2);
  await assertRejects(() => shipWal(base({ connection }, spool)));
  assertEquals([...Deno.readDirSync(spool)].map((e) => e.name), [SEG2]);
});

Deno.test("off, or with no destination, the spool is only pruned and nothing is reported", async () => {
  for (const over of [{ enabled: false }, { connection: null }]) {
    const spool = await spoolWith([SEG1, SEG2]);
    let reported = false;
    const outcome = await shipWal(base({
      ...over,
      connection: "connection" in over ? null : fakeConnection().connection,
      report: () => {
        reported = true;
        return Promise.resolve();
      },
    }, spool));
    assertEquals([outcome.pruned, outcome.shipped, reported], [2, 0, false]);
    // Only the marker that the chain broke here is left.
    assertEquals([...Deno.readDirSync(spool)].map((e) => e.name), [
      WAL_UNBROKEN_SINCE_FILE,
    ]);
  }
});

Deno.test("with no base backup kept there is no window to report yet", async () => {
  const spool = await spoolWith([SEG1]);
  const { connection } = fakeConnection();
  const outcome = await shipWal(
    base({ connection, earliestBaseBackupAt: null }, spool),
  );
  assertEquals(outcome.reported, false);
});

Deno.test("the earliest base backup is the oldest set that holds one", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-backups-" });
  for (
    const [name, withBase] of [
      ["20261119T030000Z-00000000-0000-4000-8000-00000000000a", false],
      ["20261120T030000Z-00000000-0000-4000-8000-00000000000b", true],
      ["20261121T030000Z-00000000-0000-4000-8000-00000000000c", true],
    ] as const
  ) {
    await Deno.mkdir(join(root, name));
    if (withBase) {
      await Deno.writeTextFile(join(root, name, BASE_BACKUP_FILE), "x");
    }
  }
  assertEquals(
    (await earliestBaseBackup(root))?.toISOString(),
    "2026-11-20T03:00:00.000Z",
  );
  assertEquals(await earliestBaseBackup(join(root, "missing")), null);
});

Deno.test("a segment still being copied (<segment>.tmp) is never shipped or removed, on or off", async () => {
  for (const enabled of [true, false]) {
    const spool = await spoolWith([SEG1, SEG2 + ".tmp"]);
    try {
      const { connection, puts } = fakeConnection();
      const outcome = await shipWal({
        spool,
        enabled,
        connection,
        encrypt: (path) => Deno.readFile(path),
        report: () => Promise.resolve(),
        earliestBaseBackupAt: new Date("2026-11-20T03:00:00Z"),
      });
      assertEquals(puts, enabled ? [walKey("prod/", SEG1)] : []);
      assertEquals(outcome.shipped + outcome.pruned, 1);
      assertEquals(
        [...Deno.readDirSync(spool)].map((e) => e.name)
          .filter((name) => name !== WAL_UNBROKEN_SINCE_FILE),
        [SEG2 + ".tmp"],
      );
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  }
});

Deno.test("pruning WAL unshipped marks the chain broken; a base backup from before it no longer opens the window", async () => {
  const spool = await spoolWith([SEG1]);
  const root = await Deno.makeTempDir({ prefix: "bakery-wal-root-" });
  try {
    // Switch off: nothing shipped, so the chain breaks at this pass.
    assertEquals(await walUnbrokenSince(spool), null);
    const brokenAt = new Date("2026-11-21T12:00:00.000Z");
    await shipWal({
      spool,
      enabled: false,
      connection: null,
      encrypt: (path) => Deno.readFile(path),
      report: () => Promise.resolve(),
      earliestBaseBackupAt: null,
      now: () => brokenAt,
    });
    assertEquals(
      (await walUnbrokenSince(spool))?.toISOString(),
      brokenAt.toISOString(),
    );
    // A set from before the break and one from after it.
    for (
      const name of [
        "20261121T030000Z-00000000-0000-4000-8000-000000000001",
        "20261121T130000Z-00000000-0000-4000-8000-000000000002",
      ]
    ) {
      await Deno.mkdir(join(root, name));
      await Deno.writeTextFile(join(root, name, BASE_BACKUP_FILE), "base");
    }
    assertEquals(
      (await earliestBaseBackup(root))?.toISOString(),
      "2026-11-21T03:00:00.000Z",
    );
    assertEquals(
      (await earliestBaseBackup(root, await walUnbrokenSince(spool)))
        ?.toISOString(),
      "2026-11-21T13:00:00.000Z",
    );
    // An empty off pass does not move the mark.
    await shipWal({
      spool,
      enabled: false,
      connection: null,
      encrypt: (path) => Deno.readFile(path),
      report: () => Promise.resolve(),
      earliestBaseBackupAt: null,
      now: () => new Date("2026-11-21T14:00:00.000Z"),
    });
    assertEquals(
      (await walUnbrokenSince(spool))?.toISOString(),
      brokenAt.toISOString(),
    );
  } finally {
    await Deno.remove(spool, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("switch on with no destination also breaks the chain", async () => {
  const spool = await spoolWith([SEG1]);
  try {
    await shipWal({
      spool,
      enabled: true,
      connection: null,
      encrypt: (path) => Deno.readFile(path),
      report: () => Promise.resolve(),
      earliestBaseBackupAt: new Date("2026-11-20T03:00:00Z"),
      now: () => new Date("2026-11-21T12:00:00.000Z"),
    });
    assertEquals(
      (await walUnbrokenSince(spool))?.toISOString(),
      "2026-11-21T12:00:00.000Z",
    );
  } finally {
    await Deno.remove(spool, { recursive: true });
  }
});
