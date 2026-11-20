import { assert, assertEquals } from "@std/assert";
import { runRunner } from "../../scripts/deploy/backup-runner.ts";
import { readArtifact } from "../../scripts/deploy/backup-runner/backup-step.ts";
import { authTestOrigin } from "../helpers/auth.ts";
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
    stub: { calls: number; name: string | null };
    pass: () => Promise<number>;
    runs: () => Promise<Run[]>;
    state: () => Promise<string>;
  }) => Promise<T>,
  receiverOptions: Parameters<typeof startS3Receiver>[0] = {},
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "bakery-runner-e2e-" });
  const receiver = startS3Receiver(receiverOptions);
  try {
    const credential = await o.issueCredential();
    const stub = { calls: 0, name: null as string | null };
    // The stand-in for backup.sh: a finished encrypted set in the backups root.
    const backup = async () => {
      stub.calls++;
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
    return await run({ root, credential, receiver, stub, pass, runs, state });
  } finally {
    await receiver.stop();
    await Deno.remove(root, { recursive: true });
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
      await start(o);
      assertEquals(await e.pass(), 0);

      const [run] = await e.runs();
      assertEquals(run.status, "completed", JSON.stringify(run));
      assertEquals(run.locations, ["server-host", "off-site"]);
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
      const audit = await runnerAuditRows(o);
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
      assertEquals((await runnerAuditRows(o)).length, 0);
      assertEquals((await e.runs()).length, 0);
    });
  } finally {
    await o.finish();
  }
});

Deno.test("a destination that refuses the upload fails the run with its cause and keeps the local backup", async () => {
  const o = await openBackupSettingsFixture();
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
        assertEquals(await e.pass(), 1);
        const [run] = await e.runs();
        assertEquals(run.status, "failed");
        assertEquals(run.failureCode, "destination_refused");
        assert(!JSON.stringify(run).includes(accessKeyId));
        assert(!JSON.stringify(run).includes(secretAccessKey));
        assertEquals(await e.state(), "failed");
        // The backup itself was taken and stays on the host.
        assertEquals(
          (await Deno.stat(`${e.root}/${e.stub.name}/SHA256SUMS`)).isFile,
          true,
        );
        assertEquals(e.receiver.objects.size, 0);
      },
      { rejectKey: accessKeyId },
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a name re-pointed at a private address is withheld by the server and fails the run after the backup", async () => {
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
      assertEquals(run.status, "failed");
      assertEquals(run.failureCode, "destination_refused");
      assert(run.failureDetail?.includes("destination_private_address"));
      assertEquals(e.stub.calls, 1); // the local backup was still taken
      assertEquals(e.receiver.requests.length, 0);
      // The server refused to release the pair and said so in the audit row.
      const audit = await runnerAuditRows(o);
      assertEquals(audit.length, 1);
      assertEquals(audit[0].details.released, false);
      assertEquals(audit[0].details.refusal, "destination_private_address");
    });
  } finally {
    await o.finish();
  }
});
