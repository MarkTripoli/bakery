import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  assertNotQuiesced,
  type RestoreDoor,
} from "../../apps/server/src/platform/maintenance.ts";
import { applyRestoreFence } from "../../apps/server/src/modules/backups/restore-fence.ts";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";
import { clearInstallationMaintenance } from "../helpers/installation-maintenance.ts";
import {
  executorFor,
  type FakeGithub,
  fakeGithub,
  seededEffectRig,
  stageEffectRun,
} from "../helpers/external-effects.ts";
import {
  admitFundedModelRun,
  seedAdmissibleRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

/**
 * #49 [B15.03] acceptance against real Postgres, composed from the shipped
 * backup, fence, effect executor and re-enable modules:
 *
 * AC1 (the drain half): a backup whose installation never went quiet gets no
 *   cutoff, ends failed and can never be reported complete afterwards.
 * AC2: a backup taken before a provider confirmed a write is restored; the
 *   fence turns the pending local record into an unknown outcome, the executor
 *   only reconciles it (no second write), and while reconciliation is
 *   unavailable the effect stays held.
 * AC3: a complete restore is re-enabled intake, dispatch, workers by an
 *   installation administrator, and every row of the restored tasks,
 *   artifacts, runs and steps, engine records, budgets and auth is unchanged.
 *
 * The drill and restore-script half of AC1 is in
 * tests/recovery/implement-quiesced-complete-backups-and-isolated-restore_test.ts.
 */

const SET = "20261122T030000Z-49acceptance";
const STEPS = "/v1/installation/restore/steps";

async function clearRestores(database: WorkerFixture["pgDatabase"]) {
  await database.query("delete from bakery.installation_restores");
}

async function withBackupFixture<T>(
  work: (o: BackupSettingsFixture) => Promise<T>,
): Promise<T> {
  const o = await openBackupSettingsFixture();
  const cleanup = async () => {
    await clearInstallationMaintenance(o.f.pgDatabase);
    await clearRestores(o.f.pgDatabase);
  };
  try {
    await cleanup();
    return await work(o);
  } finally {
    try {
      await cleanup();
    } finally {
      await o.finish();
    }
  }
}

/** The code a door answers with, or null when it is open. */
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

Deno.test("AC1: a drain that never finishes gives no cutoff, fails the run and the run can never be reported complete", () =>
  withBackupFixture(async (o) => {
    const credential = await o.issueCredential();
    const asked = await o.admin("POST", "/v1/installation/backups", {}, {
      keyed: true,
    });
    assertEquals(asked.status, 202, await asked.clone().text());
    const claim = await (await o.runner(
      credential,
      "POST",
      "/v1/backup-runner/claims",
      {},
    )).json() as { claimed: boolean; runId: string; leaseToken: string };
    assertEquals(claim.claimed, true);
    const run = (suffix: string, body: Record<string, unknown> = {}) =>
      o.runner(
        credential,
        "POST",
        `/v1/backup-runner/runs/${claim.runId}/${suffix}`,
        { leaseToken: claim.leaseToken, ...body },
      );

    // Entered, but not quiet: the settle window has not passed.
    const entered = await run("maintenance");
    assertEquals(entered.status, 200, await entered.clone().text());
    assertEquals((await entered.json() as { state: string }).state, "draining");
    const early = await run("cutoff");
    assertEquals(early.status, 409, await early.clone().text());
    assertEquals(
      (await early.json() as { reason: string }).reason,
      "not_quiesced",
    );

    // The runner gives up on the drain, as it does after its timeout.
    const failed = await run("reports", {
      sequence: 1,
      status: "failed",
      failureCode: "drain_timeout",
      failureDetail:
        "The installation did not go quiet within 10 minutes. No backup was taken.",
    });
    assertEquals(failed.status, 200, await failed.clone().text());
    assertEquals((await failed.json() as { status: string }).status, "failed");

    // Nothing can turn it into a complete set afterwards.
    const late = await run("reports", {
      sequence: 2,
      status: "completed",
      progressPercent: 100,
    });
    assert(
      late.status >= 400,
      `a completed report was accepted: ${late.status}`,
    );
    await late.body?.cancel();
    const lateCutoff = await run("cutoff");
    assert(lateCutoff.status >= 400, `${lateCutoff.status}`);
    await lateCutoff.body?.cancel();
    const rows = await o.f.pgDatabase.query<
      { status: string; cutoffs: string }
    >(
      `select status,
              (select count(*)::text from bakery.backup_cutoffs
                where run_id = $1) as cutoffs
         from bakery.backup_runs where id = $1`,
      [claim.runId],
    );
    assertEquals(rows.rows[0], { status: "failed", cutoffs: "0" });
    const status = await (await o.admin(
      "GET",
      "/v1/installation/backups/status",
    )).json() as { state: string; maintenanceState: string };
    assertEquals(status.state, "failed");
    assertEquals(status.maintenanceState, "off");
  }));

/** Every column of one effect row, so a test can put it back as a backup held it. */
async function effectRow(
  database: WorkerFixture["pgDatabase"],
  effectId: string,
): Promise<Record<string, unknown>> {
  return (await database.query<{ row: Record<string, unknown> }>(
    "select to_jsonb(e) as row from bakery.external_effects e where id = $1",
    [effectId],
  )).rows[0].row;
}

/**
 * Puts one effect row back to what a backup held: the bytes a restore of the
 * bakery database brings back for it, while the provider keeps what it stored.
 */
async function restoreEffectRow(
  database: WorkerFixture["pgDatabase"],
  row: Record<string, unknown>,
): Promise<void> {
  const columns = (await database.query<{ name: string }>(
    `select column_name as name from information_schema.columns
      where table_schema = 'bakery' and table_name = 'external_effects'
        and column_name <> 'id' and is_generated = 'NEVER'
      order by ordinal_position`,
  )).rows.map((column) => `"${column.name}"`);
  await database.query(
    `update bakery.external_effects target
        set (${columns.join(", ")}) = (
          select ${columns.join(", ")}
            from jsonb_populate_record(null::bakery.external_effects, $1::jsonb))
      where target.id = $2`,
    [JSON.stringify(row), row.id],
  );
}

async function effectState(
  database: WorkerFixture["pgDatabase"],
  effectId: string,
) {
  return (await database.query<{ status: string; generation: number }>(
    `select status, dispatch_generation as generation
       from bakery.external_effects where id = $1`,
    [effectId],
  )).rows[0];
}

/** A provider whose read side is down: every listing answers 503. */
function listingUnavailable(github: FakeGithub): FakeGithub {
  const inner = github.fetch;
  github.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      github.calls.push({ method: "GET", path: new URL(url).pathname });
      return Promise.resolve(new Response("{}", { status: 503 }));
    }
    return inner(input, init);
  }) as typeof fetch;
  return github;
}

const withEffectFixture = <T>(work: (fixture: WorkerFixture) => Promise<T>) =>
  withWorkerFixture(async (fixture) => {
    await clearRestores(fixture.pgDatabase);
    try {
      return await work(fixture);
    } finally {
      await clearRestores(fixture.pgDatabase);
    }
  });

Deno.test("AC2: a write the provider confirmed after the backup is reconciled after the restore, never sent again", () =>
  withEffectFixture(async (fixture) => {
    const staged = await stageEffectRun(fixture, "b1503-confirmed");
    // The backup holds the effect as prepared.
    const backedUp = await effectRow(staged.db, staged.effectId);
    assertEquals(backedUp.status, "prepared");

    // After the backup the effect runs and the provider confirms the write.
    const github = fakeGithub();
    const live = executorFor(staged.db, staged.rig, github);
    const input = {
      organizationId: fixture.organizationId,
      effectId: staged.effectId,
      requestId: "b1503-request",
      traceId: "b1503-trace",
    };
    const sent = await live.runEffect(input);
    assertEquals([sent.outcome, sent.dispatched], ["confirmed", true]);
    assertEquals(github.posts(), 1);

    // The restore brings back the pending local record, then fences it.
    await restoreEffectRow(staged.db, backedUp);
    assertEquals(
      (await effectState(staged.db, staged.effectId)).status,
      "prepared",
    );
    const fenced = await withPgTransaction(
      staged.db,
      (transaction) =>
        applyRestoreFence(transaction, { backupName: SET, cutoffAt: null }),
    );
    assert(fenced.effectsHeld >= 1);
    assertEquals(
      (await effectState(staged.db, staged.effectId)).status,
      "uncertain",
    );

    // The restored record does not authorize the write again: the executor
    // reads the provider, finds the confirmed write and records it.
    const restored = executorFor(staged.db, staged.rig, github);
    for (let i = 0; i < 3; i++) {
      const result = await restored.runEffect(input);
      assertEquals(result.outcome, "confirmed");
      assertEquals(result.dispatched, false);
    }
    assertEquals(github.posts(), 1, "the provider received one write");
    assertEquals(github.comments.length, 1);
    assertEquals(
      (await effectState(staged.db, staged.effectId)).status,
      "confirmed",
    );
  }));

Deno.test("AC2: while reconciliation is unavailable the restored effect stays held and is never sent", () =>
  withEffectFixture(async (fixture) => {
    const staged = await stageEffectRun(fixture, "b1503-unavailable");
    const backedUp = await effectRow(staged.db, staged.effectId);
    const github = fakeGithub();
    const live = executorFor(staged.db, staged.rig, github);
    const input = {
      organizationId: fixture.organizationId,
      effectId: staged.effectId,
      requestId: "b1503-request",
      traceId: "b1503-trace",
    };
    assertEquals((await live.runEffect(input)).outcome, "confirmed");
    assertEquals(github.posts(), 1);

    await restoreEffectRow(staged.db, backedUp);
    await withPgTransaction(
      staged.db,
      (transaction) =>
        applyRestoreFence(transaction, { backupName: SET, cutoffAt: null }),
    );
    const generation =
      (await effectState(staged.db, staged.effectId)).generation;

    // The provider cannot be read: the outcome stays unknown, nothing is sent.
    const down = executorFor(staged.db, staged.rig, listingUnavailable(github));
    for (let i = 0; i < 3; i++) {
      const result = await down.runEffect(input);
      assertEquals(result.outcome, "uncertain");
      assertEquals(result.dispatched, false);
    }
    assert(github.lists() >= 1, "the executor tried to reconcile");
    assertEquals(github.posts(), 1, "no second write while unavailable");
    assertEquals(await effectState(staged.db, staged.effectId), {
      status: "uncertain",
      generation,
    });
  }));

/**
 * Tables the fence and the re-enable steps write by design, and the audit and
 * session bookkeeping every request writes. Every other table of the bakery
 * schema must come out of the re-enable byte for byte as the restore left it.
 */
const WRITTEN_BY_RESTORE = new Set([
  "installation_restores",
  "external_effects",
  "job_attempts",
  "jobs",
  "worker_hosts",
  "audit_events",
  "domain_events",
  "outbox",
  "idempotency_records",
]);

async function tableDigests(
  database: WorkerFixture["pgDatabase"],
): Promise<Map<string, string>> {
  const tables = (await database.query<{ name: string }>(
    `select table_name as name from information_schema.tables
      where table_schema = 'bakery' and table_type = 'BASE TABLE'
      order by table_name`,
  )).rows.map((row) => row.name).filter((name) =>
    !WRITTEN_BY_RESTORE.has(name)
  );
  const digests = new Map<string, string>();
  for (const table of tables) {
    const row = (await database.query<{ digest: string | null }>(
      `select md5(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text))
          as digest from bakery."${table}" t`,
    )).rows[0];
    digests.set(table, row.digest ?? "empty");
  }
  return digests;
}

Deno.test("AC3: ordered re-enable of a healthy restore preserves tasks, artifacts, run state, engine records, budgets and auth", () =>
  withBackupFixture(async (o) => {
    const database = o.f.pgDatabase;
    // A restored installation with real self-development state in it.
    await seedProviderPricingSnapshot(database);
    const run = await admitFundedModelRun(
      database,
      await seedAdmissibleRun(database, o.f.organizationId, o.f.adminId, {
        reservationUsd: "0.1",
        stepKey: "b1503-restore",
      }),
    );
    const artifactId = (await database.query<{ id: string }>(
      `insert into bakery.artifacts (organization_id, task_id, artifact_type, name)
       values ($1, $2, 'plan', 'b1503 restored plan') returning id`,
      [o.f.organizationId, run.taskId],
    )).rows[0].id;
    // Checkpoint rows are the easiest thing for a restore to drop: both
    // tables digest as "empty" when unseeded, so seed one row of each.
    const draftId = crypto.randomUUID();
    await database.query(
      `insert into bakery.artifact_drafts
         (id, organization_id, artifact_id, task_id, epoch, server_sequence, status)
       values ($1, $2, $3, $4, 1, 0, 'active')`,
      [draftId, o.f.organizationId, artifactId, run.taskId],
    );
    await database.query(
      `insert into bakery.artifact_draft_checkpoints
         (id, organization_id, draft_id, epoch, server_sequence, state,
          frontiers, text_content, text_digest)
       values ($1, $2, $3, 1, 0, '\\x01', '\\x02', 'b1503 draft', 'digest')`,
      [crypto.randomUUID(), o.f.organizationId, draftId],
    );
    const rig = await seededEffectRig(
      database,
      o.f.organizationId,
      o.f.adminId,
    );
    await database.query(
      `insert into bakery.integration_sync_checkpoints
         (id, organization_id, connection_id, installation_id, resource_id,
          stream, status)
       select $1, $2, $3, installation_id, $4, 'issues', 'idle'
         from bakery.integration_connections where id = $3`,
      [
        crypto.randomUUID(),
        o.f.organizationId,
        rig.connectionId,
        rig.resourceId,
      ],
    );
    const counted = await database.query<Record<string, string>>(
      `select
         (select count(*)::text from bakery.tasks where id = $1) as tasks,
         (select count(*)::text from bakery.artifacts where task_id = $1) as artifacts,
         (select count(*)::text from bakery.artifact_draft_checkpoints
           where organization_id = $5) as draft_checkpoints,
         (select count(*)::text from bakery.integration_sync_checkpoints
           where organization_id = $5) as sync_checkpoints,
         (select count(*)::text from bakery.workflow_runs where id = $2) as runs,
         (select count(*)::text from bakery.run_steps where run_id = $2) as steps,
         (select count(*)::text from bakery.budget_reservations
           where id = $3) as reservations,
         (select count(*)::text from bakery.principals where id = $4) as auth`,
      [
        run.taskId,
        run.runId,
        run.runReservationId,
        o.f.adminId,
        o.f.organizationId,
      ],
    );
    for (const [name, count] of Object.entries(counted.rows[0])) {
      assert(Number(count) >= 1, `${name} was seeded`);
    }

    // Read-only checks passed (the drill, in the recovery lane); the fence ran.
    const fenced = await withPgTransaction(
      database,
      (transaction) =>
        applyRestoreFence(transaction, {
          backupName: SET,
          cutoffAt: "2026-11-22T03:00:05.000Z",
        }),
    );
    const closed = "INSTALLATION_RESTORING";
    assertEquals(await doors(database), [closed, closed, closed]);
    const before = await tableDigests(database);

    // Out of order is refused and opens nothing.
    const early = await o.admin("POST", STEPS, {
      step: "workers",
      confirmation: SET,
    }, { keyed: true });
    assertEquals(early.status, 409, await early.clone().text());
    await early.body?.cancel();
    assertEquals(await doors(database), [closed, closed, closed]);

    const opened: (string | null)[][] = [];
    for (const step of ["intake", "dispatch", "workers"]) {
      const taken = await o.admin("POST", STEPS, {
        step,
        confirmation: SET,
      }, { keyed: true });
      assertEquals(taken.status, 200, await taken.clone().text());
      await taken.body?.cancel();
      opened.push(await doors(database));
    }
    assertEquals(opened, [
      [null, closed, closed],
      [null, null, closed],
      [null, null, null],
    ]);
    const record = await database.query<{ released: boolean }>(
      `select released_at is not null as released
         from bakery.installation_restores where id = $1`,
      [fenced.restoreId],
    );
    assertEquals(record.rows[0].released, true);

    // Every restored row is as the restore left it.
    const after = await tableDigests(database);
    const changed = [...before.keys()].filter((table) =>
      before.get(table) !== after.get(table)
    );
    assertEquals(
      changed,
      [],
      `changed by the re-enable: ${changed.join(", ")}`,
    );
    // The restored job is still queued for the same run, and auth still works:
    // the administrator's restored session reads the installation.
    const job = await database.query<{ status: string }>(
      "select status from bakery.jobs where id = $1",
      [run.jobId],
    );
    assertEquals(job.rows[0].status, "queued");
    const status = await o.admin("GET", "/v1/installation/status");
    assertEquals(status.status, 200, await status.clone().text());
    assertEquals(
      (await status.json() as { restoreHeld: boolean }).restoreHeld,
      false,
    );
  }));
