import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  BASE_BACKUP_FILE,
  earliestBaseBackup,
  shipWal,
  walKey,
  type WalShipDeps,
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
    assertEquals([...Deno.readDirSync(spool)].length, 0);
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
