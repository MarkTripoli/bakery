import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  assertNotQuiesced,
  type RestoreDoor,
} from "../../apps/server/src/platform/maintenance.ts";
import { applyRestoreFence } from "../../apps/server/src/modules/backups/restore-fence.ts";
import {
  keyFingerprint,
  type Manifest,
  STORES,
  verifyBackupDirectory,
} from "../../scripts/deploy/backup-runner/manifest.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";
import {
  entries,
  KEY_MATERIAL,
  withSandbox,
} from "../helpers/backup-script-sandbox.ts";
import {
  apiCall,
  createPresetTask,
  presetBudgetEnv,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

/**
 * #49 [B15.03] acceptance, the authorization and credential boundaries of
 * backup and restore:
 *
 * - only an installation administrator's session drives the re-enable steps; a
 *   developer, an anonymous caller and the backup runner's credential are
 *   refused and open nothing;
 * - while a restore is held the installation refuses new work and worker
 *   claims, and a worker from before the restore is locked out;
 * - the secrets key is never in a backup set: the set records its id and a
 *   fingerprint, and only the operator-held key file matches it.
 */

const SET = "20261122T030000Z-49security";
const STEPS = "/v1/installation/restore/steps";
const CLOSED = "INSTALLATION_RESTORING";

async function doorAnswer(
  database: WorkerFixture["pgDatabase"],
  door: RestoreDoor,
): Promise<string | null> {
  try {
    await withPgTransaction(
      database,
      (transaction) => assertNotQuiesced(transaction, door),
    );
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

const doors = async (database: WorkerFixture["pgDatabase"]) => [
  await doorAnswer(database, "intake"),
  await doorAnswer(database, "dispatch"),
  await doorAnswer(database, "workers"),
];

const fence = (database: WorkerFixture["pgDatabase"]) =>
  withPgTransaction(
    database,
    (transaction) =>
      applyRestoreFence(transaction, { backupName: SET, cutoffAt: null }),
  );

async function withHeldRestore(
  work: (o: BackupSettingsFixture) => Promise<void>,
): Promise<void> {
  const o = await openBackupSettingsFixture();
  const clear = () =>
    o.f.pgDatabase.query("delete from bakery.installation_restores");
  try {
    await clear();
    await fence(o.f.pgDatabase);
    await work(o);
  } finally {
    try {
      await clear();
    } finally {
      await o.finish();
    }
  }
}

Deno.test("only an installation administrator's session takes a restore step; a developer, no one and the runner credential open nothing", () =>
  withHeldRestore(async (o) => {
    const database = o.f.pgDatabase;
    const body = { step: "intake", confirmation: SET };
    const state = async () =>
      JSON.stringify(
        (await database.query(
          `select intake_enabled_at, dispatch_enabled_at, workers_enabled_at,
                  released_at from bakery.installation_restores`,
        )).rows,
      );
    const before = await state();

    const anonymous = await o.f.app.fetch(
      new Request(`${authTestOrigin}${STEPS}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: authTestOrigin,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
    );
    assertEquals(anonymous.status, 401, await anonymous.clone().text());
    await anonymous.body?.cancel();

    const developer = await o.admin("POST", STEPS, body, {
      keyed: true,
      cookie: o.f.developerCookie,
    });
    assertEquals(developer.status, 403, await developer.clone().text());
    const refusal = await developer.text();
    assert(!refusal.includes(SET), "a refusal does not name the held set");

    const credential = await o.issueCredential();
    const runner = await o.runner(credential, "POST", STEPS, body);
    assert(
      [401, 403].includes(runner.status),
      `the runner credential took a step: ${runner.status}`,
    );
    await runner.body?.cancel();

    // The administrator must type the set's own name.
    const unconfirmed = await o.admin("POST", STEPS, {
      step: "intake",
      confirmation: "something-else",
    }, { keyed: true });
    assert(unconfirmed.status >= 400, `${unconfirmed.status}`);
    await unconfirmed.body?.cancel();

    assertEquals(await state(), before);
    assertEquals(await doors(database), [CLOSED, CLOSED, CLOSED]);

    // The administrator's session does take it.
    const admin = await o.admin("POST", STEPS, body, { keyed: true });
    assertEquals(admin.status, 200, await admin.clone().text());
    await admin.body?.cancel();
    assertEquals(await doors(database), [null, CLOSED, CLOSED]);
  }));

Deno.test("while a restore is held a run start and a worker claim are refused, and a worker from before the restore is locked out", () =>
  withWorkerFixture(async (f) => {
    const clear = () =>
      f.pgDatabase.query("delete from bakery.installation_restores");
    await clear();
    try {
      const agent = await seedFundedCodingAgent(
        f,
        f,
        `b1503-${crypto.randomUUID().slice(0, 8)}`,
      );
      const repository = await seedPresetRepository(f.pgDatabase, f, {
        agentVersionId: agent,
      });
      const task = await createPresetTask(f, f, repository);
      const old = await registeredWorker(f, { name: "b1503-before-restore" });

      await fence(f.pgDatabase);
      const runs = async () =>
        (await f.pgDatabase.query<{ n: string }>(
          "select count(*)::text as n from bakery.workflow_runs",
        )).rows[0].n;
      const runsBefore = await runs();

      const start = await startPresetRun(f, f, task, repository);
      assertEquals(start.status, 503, await start.clone().text());
      assertEquals((await start.json() as { code: string }).code, CLOSED);
      assertEquals(await runs(), runsBefore, "no run was started");

      const fresh = await registeredWorker(f, { name: "b1503-after-restore" });
      const claimKey = crypto.randomUUID();
      const claim = await workerRequest(
        f,
        fresh.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: fresh.registration.workerHostId,
          capabilities: workerFixtureCapabilities,
        },
        { idempotencyKey: claimKey },
      );
      assertEquals(claim.status, 503, await claim.clone().text());
      assertEquals((await claim.json() as { code: string }).code, CLOSED);

      const oldKey = crypto.randomUUID();
      const stale = await workerRequest(
        f,
        old.credential,
        "/v1/worker/claims",
        {
          claimKey: oldKey,
          workerHostId: old.registration.workerHostId,
          capabilities: workerFixtureCapabilities,
        },
        { idempotencyKey: oldKey },
      );
      assert(
        [401, 403, 409, 503].includes(stale.status),
        `a revoked worker was served: ${stale.status}`,
      );
      await stale.body?.cancel();
      const host = await f.pgDatabase.query<{ status: string }>(
        "select status from bakery.worker_hosts where id = $1",
        [old.registration.workerHostId],
      );
      assertEquals(host.rows[0].status, "revoked");

      // Reads stay up for the operator while held.
      const read = await apiCall(f, f, "GET", "/v1/installation/status");
      assertEquals(read.status, 200, await read.clone().text());
      await read.body?.cancel();
    } finally {
      await clear();
    }
  }, { env: presetBudgetEnv }));

Deno.test("the secrets key is never in a backup set: the set holds its id and fingerprint, and only the operator's key matches", async () => {
  // The declared stores never put host keys in a set.
  const host = STORES.find((store) => store.id === "host-configuration");
  assertEquals(host?.file, null);
  assertEquals(
    STORES.find((store) => store.id === "secrets-key-identity")?.file,
    null,
  );

  await withSandbox({}, async (box) => {
    const done = await box.run();
    assertEquals(done.code, 0, done.stderr);
    const name = /BACKUP_COMPLETED (\S+)/.exec(done.stdout)?.[1];
    assert(name, done.stdout);
    const set = join(box.backups, name);
    const raw = new TextEncoder().encode(KEY_MATERIAL);
    const needles = [
      KEY_MATERIAL,
      btoa(KEY_MATERIAL),
      [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    ];
    for (const entry of await entries(set)) {
      const bytes = await Deno.readTextFile(join(set, entry));
      for (const needle of needles) {
        assert(!bytes.includes(needle), `${entry} holds the secrets key`);
      }
    }
    for (const needle of needles) {
      assert(!done.stdout.includes(needle) && !done.stderr.includes(needle));
    }
    const manifest = JSON.parse(
      await Deno.readTextFile(join(set, "manifest.json")),
    ) as Manifest;
    const identity = manifest.stores.find((store) =>
      store.id === "secrets-key-identity"
    );
    assertEquals(identity?.keyFingerprint, keyFingerprint(raw));

    // The operator's key file matches; any other key does not.
    const keyFile = join(box.dir, "etc/bakery/secrets.key");
    assertEquals(
      (await verifyBackupDirectory(set, { keyFile })).complete,
      true,
    );
    const other = join(box.dir, "other.key");
    await Deno.writeTextFile(other, "a key from another installation");
    const wrong = await verifyBackupDirectory(set, { keyFile: other });
    assertEquals(wrong.complete, false);
    assert(wrong.problems.length > 0);
  });
});
