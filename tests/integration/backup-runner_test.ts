import { assert, assertEquals } from "@std/assert";
import { runRunner } from "../../scripts/deploy/backup-runner.ts";
import { readArtifact } from "../../scripts/deploy/backup-runner/backup-step.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import type { Cutoff } from "../../apps/server/src/modules/backups/cutoff-rules.ts";
import {
  removeSeededEffects,
  seedEffect,
} from "../helpers/external-effects-seed.ts";
import {
  accessKeyId,
  type BackupSettingsFixture,
  namedHost,
  offsiteBody,
  openBackupSettingsFixture,
  publicAddress,
  secretAccessKey,
  startS3Receiver,
} from "../helpers/backup-settings.ts";

/**
 * #80 slice S1c, end to end: the host runner (in-process, with a stand-in for
 * backup.sh because pg_dump and age live on the real host) against the REAL
 * server and Postgres, and an S3-compatible receiver on loopback. What it shows
 * is that the runner and the server agree on the protocol: claim, then the
 * settings read, then reports, and that an administrator sees the result.
 */

type Run = {
  id: string;
  status: string;
  sizeBytes: string | null;
  locations: string[];
  failureCode: string | null;
  failureDetail: string | null;
};

const setName = () =>
  `${
    new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")
  }-${crypto.randomUUID()}`;

async function runnerAuditRows(o: BackupSettingsFixture) {
  return (await o.f.pgDatabase.query<
    { outcome: string; details: Record<string, unknown> }
  >(
    `select outcome, details from bakery.audit_events
      where operation = 'backupRunner.settings' order by created_at, id`,
  )).rows;
}

async function withEnvironment<T>(
  o: BackupSettingsFixture,
  run: (context: {
    root: string;
    credential: string;
    receiver: ReturnType<typeof startS3Receiver>;
    stub: { calls: number; name: string | null; cutoffs: Cutoff[] };
    /** The settings-release audit rows written since this test began. */
    audit: () => Promise<Awaited<ReturnType<typeof runnerAuditRows>>>;
    pass: () => Promise<number>;
    runs: () => Promise<Run[]>;
    state: () => Promise<string>;
  }) => Promise<T>,
  receiverOptions: Parameters<typeof startS3Receiver>[0] = {},
): Promise<T> {
  // Audit rows are not cleared between fixtures: count only what this test adds.
  const auditBase = (await runnerAuditRows(o)).length;
  const root = await Deno.makeTempDir({ prefix: "bakery-runner-e2e-" });
  const receiver = startS3Receiver(receiverOptions);
  try {
    const credential = await o.issueCredential();
    const stub = {
      calls: 0,
      name: null as string | null,
      cutoffs: [] as Cutoff[],
    };
    // The stand-in for backup.sh: a finished encrypted set in the backups root.
    const backup = async (
      _signal: AbortSignal,
      _secrets: unknown,
      cutoff: Cutoff,
    ) => {
      stub.calls++;
      stub.cutoffs.push(cutoff);
      const name = setName();
      stub.name = name;
      await Deno.mkdir(`${root}/${name}`);
      const files: Record<string, string> = {
        "bakery.dump.age": "bakery-dump-bytes".repeat(20),
        "inngest.dump.age": "inngest-dump-bytes".repeat(10),
        "files.tar.gz.age": "files-bytes".repeat(5),
        "release.json": "{}",
        SHA256SUMS: "sums\n",
      };
      for (const [file, text] of Object.entries(files)) {
        await Deno.writeTextFile(`${root}/${name}/${file}`, text);
      }
      return await readArtifact(root, name);
    };
    // The runner reaches the server through its in-process app.
    const fetcher: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", authTestOrigin);
      return Promise.resolve(
        o.f.app.fetch(new Request(String(input), { ...init, headers })),
      );
    };
    const logs: string[] = [];
    const pass = () =>
      runRunner({
        env: {
          BAKERY_API_URL: authTestOrigin,
          BAKERY_BACKUP_RUNNER_TOKEN: credential,
          BAKERY_ENV: "test",
        },
        backupsRoot: root,
        backup,
        fetch: fetcher,
        log: (line) => logs.push(line),
      });
    const runs = async () => {
      const response = await o.admin("GET", "/v1/installation/backups");
      assertEquals(response.status, 200, await response.clone().text());
      return (await response.json() as { items: Run[] }).items;
    };
    const state = async () => {
      const response = await o.admin("GET", "/v1/installation/backups/status");
      return (await response.json() as { state: string }).state;
    };
    const audit = async () => (await runnerAuditRows(o)).slice(auditBase);
    return await run({
      root,
      credential,
      receiver,
      stub,
      audit,
      pass,
      runs,
      state,
    });
  } finally {
    await receiver.stop();
    await Deno.remove(root, { recursive: true });
    await removeSeededEffects(o.f.pgDatabase);
  }
}

async function start(o: BackupSettingsFixture) {
  const response = await o.admin("POST", "/v1/installation/backups", {}, {
    keyed: true,
  });
  assertEquals(response.status, 202, await response.clone().text());
}

Deno.test("an administrator's backup is claimed, taken, copied off-site and shown as protected, with one audited release of the key pair", async () => {
  const o = await openBackupSettingsFixture({ realProbe: true });
  try {
    await withEnvironment(o, async (e) => {
      const saved = await o.putOffsite(
        offsiteBody({ endpoint: e.receiver.endpoint }),
      );
      assertEquals(saved.status, 200, await saved.clone().text());
      assertEquals(
        (await o.putSchedule({
          enabled: true,
          interval: "daily",
          timeOfDayUtc: "03:00",
          daysToKeep: 30,
        })).status,
        200,
      );
      // Two effects still unsettled when the installation goes quiet, and one
      // that is settled and must not be counted.
      await seedEffect(
        o.f.pgDatabase,
        o.f.organizationId,
        "prepared",
        "github.merge",
      );
      await seedEffect(
        o.f.pgDatabase,
        o.f.organizationId,
        "uncertain",
        "slack.post",
      );
      await seedEffect(
        o.f.pgDatabase,
        o.f.organizationId,
        "confirmed",
        "github.merge",
      );
      await start(o);
      assertEquals(await e.pass(), 0);

      const [run] = await e.runs();
      assertEquals(run.status, "completed", JSON.stringify(run));
      assertEquals(run.locations, ["server-host", "off-site"]);

      // The backup step was handed the cutoff the server recorded for this run:
      // the database clock at the quiet moment, with the census of unsettled
      // effects, and it is the cutoff the administrator's status now shows.
      assertEquals(e.stub.cutoffs.length, 1);
      const cutoff = e.stub.cutoffs[0];
      assertEquals(cutoff.source, "database");
      assertEquals(cutoff.effects?.total, 2);
      assertEquals(cutoff.effects?.byOperation, [
        { operation: "github.merge", count: 1 },
        { operation: "slack.post", count: 1 },
      ]);
      const recorded = await o.f.pgDatabase.query<
        { cutoffAt: Date; digest: string }
      >(
        `select cutoff_at as "cutoffAt", effects_digest as digest
           from bakery.backup_cutoffs where run_id = $1`,
        [run.id],
      );
      assertEquals(recorded.rows.length, 1);
      assertEquals(recorded.rows[0].cutoffAt.toISOString(), cutoff.at);
      assertEquals(recorded.rows[0].digest, cutoff.effects?.digest);
      const status = await (await o.admin(
        "GET",
        "/v1/installation/backups/status",
      )).json() as { lastBackupCutoffAt: string | null };
      assertEquals(status.lastBackupCutoffAt, cutoff.at);
      const stored = [...e.receiver.objects.entries()].filter(([key]) =>
        key.startsWith(`/bakery-backups/prod/${e.stub.name}/`)
      );
      assertEquals(stored.length, 5);
      assertEquals(
        String(stored.reduce((sum, [, bytes]) => sum + bytes.length, 0)),
        run.sizeBytes,
      );
      assertEquals(await e.state(), "protected");

      // The one read that released the pair was audited, without any key.
      const audit = await e.audit();
      assertEquals(audit.length, 1);
      assertEquals(audit[0].details.released, true);
      const text = JSON.stringify(audit);
      assert(!text.includes(accessKeyId));
      assert(!text.includes(secretAccessKey));
      assert(!text.includes(e.credential));
    });
  } finally {
    await o.finish();
  }
});

Deno.test("an idle poll claims nothing, reads no settings and writes no audit row", async () => {
  const o = await openBackupSettingsFixture({ realProbe: true });
  try {
    await withEnvironment(o, async (e) => {
      const saved = await o.putOffsite(
        offsiteBody({ endpoint: e.receiver.endpoint }),
      );
      assertEquals(saved.status, 200);
      for (let poll = 0; poll < 3; poll++) assertEquals(await e.pass(), 0);
      assertEquals(e.stub.calls, 0);
      assertEquals((await e.audit()).length, 0);
      assertEquals((await e.runs()).length, 0);
    });
  } finally {
    await o.finish();
  }
});

Deno.test("a destination that refuses the upload leaves the backup completed on the host as 'not copied off-site', and a later good backup supersedes it", async () => {
  const o = await openBackupSettingsFixture();
  const good = startS3Receiver();
  try {
    await withEnvironment(
      o,
      async (e) => {
        // The save is not probed here (a steered probe), so the refusal only
        // shows when the runner uploads for real.
        assertEquals(
          (await o.putOffsite(offsiteBody({ endpoint: e.receiver.endpoint })))
            .status,
          200,
        );
        await start(o);
        assertEquals(await e.pass(), 1); // a reported problem: the unit shows failed
        const [run] = await e.runs();
        // Completed, not failed: the backup was taken and is on the host.
        assertEquals(run.status, "completed", JSON.stringify(run));
        assertEquals(run.locations, ["server-host"]);
        assertEquals(run.failureCode, "destination_refused");
        assert(run.failureDetail !== null && run.failureDetail !== "");
        assert(run.sizeBytes !== null);
        assert(!JSON.stringify(run).includes(accessKeyId));
        assert(!JSON.stringify(run).includes(secretAccessKey));
        // Its OWN state: not "failed", not "protected".
        assertEquals(await e.state(), "not_copied");
        const status = await o.admin("GET", "/v1/installation/backups/status");
        const body = await status.json() as { lastGoodBackupAt: string | null };
        // The local copy counts as a backup taken.
        assert(body.lastGoodBackupAt !== null);
        // The backup itself stays on the host; nothing reached the destination.
        assertEquals(
          (await Deno.stat(`${e.root}/${e.stub.name}/SHA256SUMS`)).isFile,
          true,
        );
        assertEquals(e.receiver.objects.size, 0);

        // The destination is fixed; the next backup is a good FULL one and it
        // supersedes the amber state.
        assertEquals(
          (await o.putOffsite(offsiteBody({ endpoint: good.endpoint }), {
            version: 1,
          })).status,
          200,
        );
        await start(o);
        assertEquals(await e.pass(), 0);
        const [newest, older] = await e.runs();
        assertEquals(newest.status, "completed");
        assertEquals(newest.locations, ["server-host", "off-site"]);
        assertEquals(newest.failureCode, null);
        assertEquals(older.failureCode, "destination_refused");
        assertEquals(await e.state(), "protected");
      },
      { rejectKey: accessKeyId },
    );
  } finally {
    await good.stop();
    await o.finish();
  }
});

Deno.test("a name re-pointed at a private address is withheld by the server and the backup is completed on the host, not copied off-site", async () => {
  const o = await openBackupSettingsFixture();
  try {
    await withEnvironment(o, async (e) => {
      o.setHost(namedHost, [publicAddress]);
      assertEquals(
        (await o.putOffsite(
          offsiteBody({ endpoint: `https://${namedHost}` }),
        )).status,
        200,
      );
      // Re-pointed after it was saved.
      o.setHost(namedHost, ["10.0.0.5"]);
      await start(o);
      assertEquals(await e.pass(), 1);
      const [run] = await e.runs();
      assertEquals(run.status, "completed", JSON.stringify(run));
      assertEquals(run.locations, ["server-host"]);
      assertEquals(run.failureCode, "destination_refused");
      assert(run.failureDetail?.includes("destination_private_address"));
      assertEquals(await e.state(), "not_copied");
      assertEquals(e.stub.calls, 1); // the local backup was taken and kept
      assertEquals(
        (await Deno.stat(`${e.root}/${e.stub.name}/SHA256SUMS`)).isFile,
        true,
      );
      // No S3 client call reached the receiver. Its random loopback port can
      // also get an unsigned probe from another process on a shared host.
      assertEquals(e.receiver.signedRequests, []);
      // The server refused to release the pair and said so in the audit row.
      const audit = await e.audit();
      assertEquals(audit.length, 1);
      assertEquals(audit[0].details.released, false);
      assertEquals(audit[0].details.refusal, "destination_private_address");
    });
  } finally {
    await o.finish();
  }
});
