import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  ensureCoherent,
  type Exec,
  runDrill,
} from "../../scripts/deploy/backup-runner/drill.ts";
import {
  INCOMPLETE_FILE,
  verifyBackupDirectory,
} from "../../scripts/deploy/backup-runner/manifest.ts";
import {
  DRILL_CHECKS,
  drillProblems,
} from "../../apps/server/src/modules/backups/drill-rules.ts";
import {
  CUTOFF_AT,
  type DrillFixture,
  ok,
  POSTGRES,
  withDrillFixture,
} from "../helpers/backup-drill-fixture.ts";
import { entries, withSandbox } from "../helpers/backup-script-sandbox.ts";
import { toolsWithoutDeno } from "../helpers/backup-sandbox-release.ts";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";

/**
 * #49 [B15.03] acceptance, the backup set and restore drill half, composed from
 * the shipped scripts/deploy/backup.sh, the restore drill
 * (scripts/deploy/backup-runner/drill.ts) and the server's drill history:
 *
 * AC1: a set with a missing key, a missing store or referenced object, a corrupt
 *   cutoff checkpoint, or one backup.sh could not finish never passes the drill,
 *   and the server keeps it as failed and refuses a report that says otherwise.
 * The healthy path restores into isolated, network-less stores, checks
 *   references, hashes, migrations and the key, and records the backup age (RPO)
 *   and the restore time (RTO).
 *
 * The drain half of AC1, and AC2 and AC3, are in
 * tests/integration/implement-quiesced-complete-backups-and-isolated-restore_test.ts.
 */

const DRILLS = "/v1/backup-runner/drills";

type Recorded = { outcome: string; failureCode: string | null };

/** The installation's drill history, as the runner reports into it. */
async function withHistory(
  work: (record: {
    report: (body: Record<string, unknown>) => Promise<Response>;
    count: () => Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  const o: BackupSettingsFixture = await openBackupSettingsFixture();
  const clear = () => o.f.pgDatabase.query("delete from bakery.backup_drills");
  try {
    await clear();
    const credential = await o.issueCredential();
    await work({
      report: async (body) => await o.runner(credential, "POST", DRILLS, body),
      count: async () =>
        Number(
          (await o.f.pgDatabase.query<{ n: string }>(
            "select count(*)::text as n from bakery.backup_drills",
          )).rows[0].n,
        ),
    });
  } finally {
    try {
      await clear();
    } finally {
      await o.finish();
    }
  }
}

Deno.test("a healthy set passes every isolated restore check and the history keeps its RPO and RTO", () =>
  withHistory(async (history) => {
    await withDrillFixture({}, async (f) => {
      const times = [
        new Date("2026-11-21T04:00:00.000Z"),
        new Date("2026-11-21T04:02:22.400Z"),
      ];
      let index = 0;
      const outcome = await f.run({
        now: () => times[Math.min(index++, times.length - 1)],
      });
      assertEquals(outcome.outcome, "passed", JSON.stringify(outcome));
      assertEquals(outcome.checksPassed, [...DRILL_CHECKS]);
      assertEquals(outcome.cutoffAt, CUTOFF_AT);
      assertEquals(outcome.rpoSeconds, 3595);
      assertEquals(outcome.rtoSeconds, 142);
      // Isolated: the restored database runs in a container with no network,
      // on the release's pinned image, and is removed afterwards.
      const started = f.calls.filter((call) =>
        call.startsWith("docker run --detach")
      );
      assertEquals(started.length, 1);
      assert(started[0].includes("--network none"), started[0]);
      assert(started[0].includes(POSTGRES));
      assert(
        f.calls.some((call) => call.startsWith("docker rm --force --volumes")),
      );

      const kept = await history.report({
        drillId: crypto.randomUUID(),
        ...outcome,
      });
      assertEquals(kept.status, 200, await kept.clone().text());
      const body = await kept.json() as Recorded & {
        rpoSeconds: number;
        rtoSeconds: number;
      };
      assertEquals(
        [body.outcome, body.rpoSeconds, body.rtoSeconds],
        ["passed", 3595, 142],
      );
    });
  }));

type Broken = {
  name: string;
  check: string;
  code: string;
  breakIt: (f: DrillFixture) => Promise<Parameters<DrillFixture["run"]>[0]>;
};

const BROKEN: Broken[] = [
  {
    name: "the secrets key is missing",
    check: "key",
    code: "key_mismatch",
    breakIt: () => Promise.resolve({ keyFile: null }),
  },
  {
    name: "the key is not the one the set was taken with",
    check: "key",
    code: "key_mismatch",
    breakIt: async (f) => {
      const other = join(f.dir, "other.key");
      await Deno.writeTextFile(other, "another installation's key");
      return { keyFile: other };
    },
  },
  {
    name: "a store's file is missing",
    check: "checksums",
    code: "set_incomplete",
    breakIt: async (f) => {
      await Deno.remove(join(f.set, "inngest.dump.age"));
      return {};
    },
  },
  {
    name: "an object the database refers to is missing",
    check: "references",
    code: "references_missing",
    breakIt: () => Promise.resolve({ script: { "skip-skill-file": ok() } }),
  },
  {
    name: "the restored cutoff checkpoint is corrupt",
    check: "cutoff",
    code: "cutoff_mismatch",
    breakIt: () =>
      Promise.resolve({ script: { "backup_cutoffs": ok("f".repeat(64)) } }),
  },
  {
    name: "the set was left incomplete by a failed capture",
    check: "manifest",
    code: "set_incomplete",
    breakIt: async (f) => {
      await Deno.writeTextFile(
        join(f.set, INCOMPLETE_FILE),
        JSON.stringify({
          format: 1,
          complete: false,
          cause: "store_failed",
          detail: "the redis save failed",
          failedStores: ["redis"],
          startedAt: "2026-11-21T03:00:00.000Z",
        }),
      );
      return {};
    },
  },
];

Deno.test("a missing key or object, or a corrupt checkpoint, fails the drill and is kept as failed, never as complete", () =>
  withHistory(async (history) => {
    for (const broken of BROKEN) {
      await withDrillFixture({}, async (f) => {
        const outcome = await f.run(await broken.breakIt(f));
        assertEquals(outcome.outcome, "failed", broken.name);
        assertEquals(outcome.checksFailed, [broken.check], broken.name);
        assertEquals(outcome.failureCode, broken.code, broken.name);
        assert(!outcome.checksPassed.includes(broken.check as never));
        assertEquals(ensureCoherent(outcome), outcome, broken.name);
        assertEquals(drillProblems(outcome), [], broken.name);

        const stored = await history.count();
        const kept = await history.report({
          drillId: crypto.randomUUID(),
          ...outcome,
        });
        assertEquals(
          kept.status,
          200,
          `${broken.name}: ${await kept.clone().text()}`,
        );
        assertEquals(
          (await kept.json() as Recorded).outcome,
          "failed",
          broken.name,
        );
        // A runner that claims the same set passed is refused, stores nothing.
        const forged = await history.report({
          ...outcome,
          drillId: crypto.randomUUID(),
          outcome: "passed",
          failureCode: null,
          detail: null,
        });
        assertEquals(forged.status, 422, broken.name);
        await forged.body?.cancel();
        assertEquals(await history.count(), stored + 1, broken.name);
      });
    }
  }));

Deno.test("a failed store capture leaves no set at all, and a set backup.sh could not finish is refused before any restore starts", async () => {
  await withSandbox({}, async (box) => {
    // A dump that dies: no set and no latest.
    const dead = await box.run({ FAKE_FAIL_DUMP: "bakery" });
    assertEquals(dead.code, 70, dead.stderr);
    assertEquals(await entries(box.backups), []);
  });
  await withSandbox({}, async (box) => {
    // The manifest builder is missing: the dumps are kept as an incomplete set.
    await Deno.remove(join(box.bin, "deno"));
    const tools = await toolsWithoutDeno(box.dir);
    const unfinished = await box.run({ PATH: `${box.bin}:${tools}` });
    assertEquals(unfinished.code, 70, unfinished.stderr);
    const names = await entries(box.backups);
    assert(!names.includes("latest"), names.join(","));
    const name = names.find((entry) => !entry.startsWith("."));
    assert(name, "the incomplete set is kept for the operator");
    const set = join(box.backups, name);
    assertEquals((await verifyBackupDirectory(set)).complete, false);

    const calls: string[] = [];
    const exec: Exec = (command) => {
      calls.push(command.join(" "));
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const scratchRoot = join(box.dir, "scratch");
    await Deno.mkdir(scratchRoot);
    const outcome = await runDrill({
      directory: set,
      identityFile: join(box.dir, "identity.txt"),
      keyFile: join(box.dir, "etc/bakery/secrets.key"),
      releaseRoot: box.opt,
      scratchRoot,
      exec,
      sleep: () => Promise.resolve(),
    });
    assertEquals(outcome.outcome, "failed");
    assertEquals(outcome.checksFailed, ["manifest"]);
    assertEquals(outcome.failureCode, "set_incomplete");
    assertEquals(outcome.checksPassed, []);
    assertEquals(calls, [], "nothing was started for an incomplete set");
  });
});
