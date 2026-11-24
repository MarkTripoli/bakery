import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  assertNotQuiesced,
  type RestoreDoor,
} from "../../apps/server/src/platform/maintenance.ts";
import { applyRestoreFence } from "../../apps/server/src/modules/backups/restore-fence.ts";
import { sweepExecutionRetention } from "../../apps/server/src/modules/execution/coordination.ts";
import { compactDraftEpoch } from "../../apps/server/src/modules/knowledge/draft-compaction.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { clearInstallationMaintenance } from "../helpers/installation-maintenance.ts";
import {
  type Fixture,
  withPluginFixture,
} from "../helpers/plugin-pages-fixture.ts";
import {
  installFirst,
  manifestOf,
  moveInstall,
  publishVersion,
  snapshotOf,
  stateRows,
  writeState,
} from "../helpers/plugin-upgrade-fixture.ts";
import {
  adminRequest,
  registeredWorker,
  seedEligibleJob,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedLegacyLeasedModelAttempt } from "../helpers/worker-execution/legacy-attempt.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";

const SET = "20261124T030000Z-64f1acceptance";
const STEPS = "/v1/installation/restore/steps";
const CLOSED = "INSTALLATION_RESTORING";
const PLUGIN_CAPABILITIES = [
  ...workerFixtureCapabilities,
  "plugin.job.contained",
];

const WRITTEN_BY_RESTORE = new Set([
  "installation_restores",
  "external_effects",
  "job_attempts",
  "jobs",
  "worker_hosts",
  "audit_events",
  "domain_events",
  "event_clock",
  "outbox",
  "idempotency_records",
]);

type Database = Fixture["pgDatabase"];

async function doorAnswer(
  database: Database,
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

const doors = async (database: Database) => [
  await doorAnswer(database, "intake"),
  await doorAnswer(database, "dispatch"),
  await doorAnswer(database, "workers"),
];

async function clearRestores(database: Database) {
  await database.query("delete from bakery.installation_restores");
}

function withRestoreFixture(
  work: (
    fixture: Fixture,
    store: Parameters<Parameters<typeof withPluginFixture>[0]>[1],
  ) => Promise<void>,
) {
  return withPluginFixture(async (fixture, store) => {
    await clearInstallationMaintenance(fixture.pgDatabase);
    await clearRestores(fixture.pgDatabase);
    try {
      await work(fixture, store);
    } finally {
      try {
        await fixture.pgDatabase.query(
          "delete from bakery.provider_routes where organization_id = $1",
          [fixture.organizationId],
        );
        await clearInstallationMaintenance(fixture.pgDatabase);
      } finally {
        await clearRestores(fixture.pgDatabase);
      }
    }
  });
}

async function tableDigests(
  database: Database,
  skip: ReadonlySet<string> = WRITTEN_BY_RESTORE,
): Promise<Map<string, string>> {
  const tables = (await database.query<{ name: string }>(
    `select table_name as name from information_schema.tables
      where table_schema = 'bakery' and table_type = 'BASE TABLE'
      order by table_name`,
  )).rows.map((row) => row.name).filter((name) => !skip.has(name));
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

function changedTables(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  return [...before.keys()].filter((table) =>
    before.get(table) !== after.get(table)
  );
}

async function fenceAndReenable(fixture: Fixture) {
  const fenced = await withPgTransaction(
    fixture.pgDatabase,
    (transaction) =>
      applyRestoreFence(transaction, {
        backupName: SET,
        cutoffAt: "2026-11-24T03:00:05.000Z",
      }),
  );
  assertEquals(await doors(fixture.pgDatabase), [CLOSED, CLOSED, CLOSED]);
  for (const step of ["intake", "dispatch", "workers"]) {
    const taken = await adminRequest(fixture, STEPS, {
      step,
      confirmation: SET,
    }, { idempotencyKey: crypto.randomUUID() });
    assertEquals(taken.status, 200, await taken.clone().text());
    await taken.body?.cancel();
  }
  assertEquals(await doors(fixture.pgDatabase), [null, null, null]);
  const record = await fixture.pgDatabase.query<{ released: boolean }>(
    `select released_at is not null as released
       from bakery.installation_restores where id = $1`,
    [fenced.restoreId],
  );
  assertEquals(record.rows[0].released, true);
  return fenced;
}

async function attemptsOf(database: Database, jobId: string) {
  return (await database.query<Record<string, unknown>>(
    `select id, job_id, worker_host_id, worker_session_id, attempt_no,
            fence::text as fence, lease_token_hash, status
       from bakery.job_attempts where job_id = $1 order by attempt_no, id`,
    [jobId],
  )).rows;
}

async function jobOf(database: Database, jobId: string) {
  return (await database.query<{ status: string; fence: string }>(
    `select status, current_fence::text as fence
       from bakery.jobs where id = $1`,
    [jobId],
  )).rows[0];
}

const claimWith = (workerHostId: string, capabilities: string[]) => {
  const claimKey = crypto.randomUUID();
  return {
    claimKey,
    body: { claimKey, workerHostId, capabilities },
  };
};

Deno.test("AC2: a restore keeps a plugin install, its version pin, state and snapshot, and holds the in-flight plugin job instead of running it again", () =>
  withRestoreFixture(async (fixture, store) => {
    const database = fixture.pgDatabase;
    const first = await installFirst(fixture, store);
    await writeState(fixture, first.installId, {
      key: "mode",
      value: { enabled: true },
      schemaVersion: 1,
      expectedCasVersion: 0,
    });
    const second = await publishVersion(
      fixture,
      store,
      manifestOf(),
      first.packageId,
    );
    const moved = await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
    });
    assertEquals(moved.pluginVersionId, second.versionId);
    const snapshot = await snapshotOf(fixture, first.installId);
    assert(snapshot !== null, "the upgrade kept a snapshot");
    const stateBefore = await stateRows(fixture, first.installId);
    assertEquals(stateBefore.length, 1);

    const worker = await registeredWorker(fixture, {
      capabilities: PLUGIN_CAPABILITIES,
    });
    const job = await seedEligibleJob(
      database,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "plugin.job",
        capabilities: ["plugin.job.contained"],
        input: {
          installId: first.installId,
          entry: "jobs/nightly.sh",
          versionId: second.versionId,
        },
      },
    );
    const assignment = await claimAssignment(fixture, worker, {
      capabilities: PLUGIN_CAPABILITIES,
      supportedActions: ["plugin.job"],
    });
    assertEquals(assignment.jobId, job.jobId);
    const attemptBefore = await attemptsOf(database, job.jobId);
    assertEquals(attemptBefore.length, 1);
    assertEquals(attemptBefore[0].status, "leased");
    const fenceBefore = (await jobOf(database, job.jobId)).fence;

    const digestsBefore = await tableDigests(database);
    for (
      const table of [
        "plugin_packages",
        "plugin_versions",
        "plugin_installs",
        "plugin_install_grants",
        "plugin_state",
        "plugin_install_snapshots",
        "plugin_install_snapshot_state",
      ]
    ) {
      assert(digestsBefore.has(table), `${table} is digested`);
      assertNotEquals(digestsBefore.get(table), "empty", `${table} is seeded`);
    }

    const fenced = await fenceAndReenable(fixture);
    assertEquals(fenced.attemptsQuarantined, 1);
    assertEquals(fenced.jobsAwaitingReconciliation, 1);

    assertEquals(
      changedTables(digestsBefore, await tableDigests(database)),
      [],
    );
    const pinned = await database.query<{
      plugin_version_id: string;
      status: string;
    }>(
      `select plugin_version_id, status from bakery.plugin_installs where id = $1`,
      [first.installId],
    );
    assertEquals(pinned.rows[0].plugin_version_id, second.versionId);
    assertEquals(pinned.rows[0].status, moved.status);
    assertEquals(await stateRows(fixture, first.installId), stateBefore);
    assertEquals(await snapshotOf(fixture, first.installId), snapshot);

    const attemptAfter = await attemptsOf(database, job.jobId);
    assertEquals(attemptAfter.length, 1);
    assertEquals(attemptAfter[0], {
      ...attemptBefore[0],
      status: "quarantined",
    });
    const jobAfter = await jobOf(database, job.jobId);
    assertEquals(jobAfter.status, "awaiting_reconciliation");
    assertEquals(jobAfter.fence, String(Number(fenceBefore) + 1));

    const again = claimWith(
      worker.registration.workerHostId,
      PLUGIN_CAPABILITIES,
    );
    const refused = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      { ...again.body, supportedActions: ["plugin.job"] },
      { idempotencyKey: again.claimKey },
    );
    assertEquals(refused.status, 403);
    await refused.body?.cancel();
    assertEquals(await attemptsOf(database, job.jobId), attemptAfter);
    assertEquals(
      (await jobOf(database, job.jobId)).status,
      "awaiting_reconciliation",
    );
  }));

Deno.test("AC2: a restore keeps a paused machine's identity, bindings, routes and maintenance history, revokes it as the runbook says, and holds its jobs", () =>
  withRestoreFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    const worker = await registeredWorker(fixture);
    const hostId = worker.registration.workerHostId;
    const inFlight = await seedEligibleJob(
      database,
      fixture.organizationId,
      fixture.principalId,
      { legacy: true },
    );
    await seedLegacyLeasedModelAttempt(fixture, worker, inFlight.jobId);
    const queued = await seedEligibleJob(
      database,
      fixture.organizationId,
      fixture.principalId,
      { legacy: true },
    );

    const paused = await adminRequest(
      fixture,
      `/v1/workers/${hostId}`,
      { status: "offline" },
      { method: "PATCH", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(paused.status, 200, await paused.clone().text());
    await paused.body?.cancel();

    const binding = (await database.query<{ id: string }>(
      `insert into bakery.worker_provider_bindings
         (organization_id, worker_host_id, component_key, provider,
          billing_route, auth_mode, credential_location, safe_problem)
       values ($1, $2, 'codex', 'openai', 'subscription', 'oauth', 'host',
               'paused for a quota reset')
       returning id`,
      [fixture.organizationId, hostId],
    )).rows[0].id;
    await database.query(
      `insert into bakery.provider_routes
         (organization_id, provider, endpoint, model, harness, billing_route,
          worker_binding_id, credential_location)
       values ($1, 'openai', 'https://api.example.test/v1', 'gpt-test',
               'codex', 'subscription', $2, 'host')`,
      [fixture.organizationId, binding],
    );
    await database.query(
      `insert into bakery.worker_maintenance_operations
         (organization_id, worker_host_id, verb, requested_by,
          expected_inventory_revision, expected_credential_generation,
          captured_desired_mode, phase, deadline_at, expires_at,
          idempotency_key, request_digest, result)
       select organization_id, id, 'verify', $2, inventory_revision,
              credential_generation, desired_mode, 'succeeded',
              clock_timestamp(), clock_timestamp() + interval '1 day',
              'f1-paused-history', 'digest', '{"ok":true}'::jsonb
         from bakery.worker_hosts where id = $1`,
      [hostId, fixture.principalId],
    );

    const hostColumns = `id, organization_id, principal_id, principal_type,
      name, os, architecture, capabilities, toolchain_versions, slots,
      credential_hash, protocol_version, archived_at, created_at,
      worker_session_id, worker_session_generation::text as session_generation,
      inventory_revision, readiness_revision`;
    const identityBefore = (await database.query<Record<string, unknown>>(
      `select ${hostColumns} from bakery.worker_hosts where id = $1`,
      [hostId],
    )).rows[0];
    const modeBefore = (await database.query<{
      status: string;
      desired_mode: string;
      credential_generation: number;
      version: number;
    }>(
      `select status, desired_mode, credential_generation, version
         from bakery.worker_hosts where id = $1`,
      [hostId],
    )).rows[0];
    assertEquals(modeBefore.status, "online");
    assertEquals(modeBefore.desired_mode, "paused");
    const unrevoked = Number(
      (await database.query<{ count: string }>(
        `select count(*)::text as count from bakery.worker_hosts
        where status <> 'revoked'`,
      )).rows[0].count,
    );
    const queuedBefore = await jobOf(database, queued.jobId);
    assertEquals(queuedBefore.status, "queued");
    const digestsBefore = await tableDigests(database);
    for (
      const table of [
        "worker_provider_bindings",
        "provider_routes",
        "worker_maintenance_operations",
      ]
    ) {
      assertNotEquals(digestsBefore.get(table), "empty", `${table} is seeded`);
    }

    const fenced = await fenceAndReenable(fixture);
    assertEquals(fenced.workersRevoked, unrevoked);
    assertEquals(fenced.attemptsQuarantined, 1);
    assertEquals(fenced.jobsAwaitingReconciliation, 1);

    assertEquals(
      changedTables(digestsBefore, await tableDigests(database)),
      [],
    );
    const identityAfter = (await database.query<Record<string, unknown>>(
      `select ${hostColumns} from bakery.worker_hosts where id = $1`,
      [hostId],
    )).rows[0];
    assertEquals(identityAfter, identityBefore);
    const modeAfter = (await database.query<{
      status: string;
      desired_mode: string;
      credential_generation: number;
      version: number;
    }>(
      `select status, desired_mode, credential_generation, version
         from bakery.worker_hosts where id = $1`,
      [hostId],
    )).rows[0];
    assertEquals(modeAfter, {
      status: "revoked",
      desired_mode: "revoked",
      credential_generation: modeBefore.credential_generation + 1,
      version: modeBefore.version + 1,
    });
    const operation = await database.query<{
      captured_desired_mode: string;
      phase: string;
    }>(
      `select captured_desired_mode, phase
         from bakery.worker_maintenance_operations where worker_host_id = $1`,
      [hostId],
    );
    assertEquals(operation.rows, [{
      captured_desired_mode: "paused",
      phase: "succeeded",
    }]);

    const trail = await database.query<{ operation: string; reason: string }>(
      `select operation, details->>'reason' as reason
         from bakery.audit_events
        where resource_type = 'worker_host' and resource_id = $1
          and operation = 'workers.revoke'`,
      [hostId],
    );
    assertEquals(trail.rows, [{
      operation: "workers.revoke",
      reason: "restore",
    }]);

    assertEquals(await jobOf(database, queued.jobId), queuedBefore);
    assertEquals(
      (await jobOf(database, inFlight.jobId)).status,
      "awaiting_reconciliation",
    );
    const held = await attemptsOf(database, inFlight.jobId);
    assertEquals(held.map((row) => row.status), ["quarantined"]);

    const heartbeat = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: hostId,
        observedAt: "2026-11-24T03:10:00.000Z",
        load: 0,
        activeAttemptIds: [],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(heartbeat.status, 403);
    await heartbeat.body?.cancel();
  }));

Deno.test("AC2: a restore keeps the compacted command log and its acknowledgement tombstones row for row, and a later retention pass loses no command", () =>
  withRestoreFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    const worker = await registeredWorker(fixture);
    const commandJob = await seedEligibleJob(
      database,
      fixture.organizationId,
      fixture.principalId,
      { legacy: true },
    );
    const assignment = await seedLegacyLeasedModelAttempt(
      fixture,
      worker,
      commandJob.jobId,
    );
    const insertCommand = async (
      type: string,
      status: string,
      acknowledgedAgo: string | null,
    ) =>
      (await database.query<{ id: string }>(
        `insert into bakery.worker_commands
           (organization_id, attempt_id, command_type, status, acknowledged_at)
         values ($1, $2, $3, $4,
                 case when $5::text is null then null
                      else clock_timestamp() - $5::interval end)
         returning id`,
        [
          fixture.organizationId,
          assignment.attemptId,
          type,
          status,
          acknowledgedAgo,
        ],
      )).rows[0].id;
    const compactedIds = [
      await insertCommand("cancel", "acknowledged", "3 days"),
      await insertCommand("message", "acknowledged", "2 days"),
      await insertCommand("message", "rejected", "2 days"),
    ];
    const pendingId = await insertCommand("message", "pending", null);
    const recentId = await insertCommand("cancel", "acknowledged", "1 minute");

    await withPgTransaction(
      database,
      (transaction) => sweepExecutionRetention(transaction),
    );
    const logRows = async () => ({
      commands: (await database.query(
        `select to_jsonb(c) as row from bakery.worker_commands c
          where attempt_id = $1 order by id`,
        [assignment.attemptId],
      )).rows,
      tombstones: (await database.query(
        `select to_jsonb(t) as row from bakery.worker_command_ack_tombstones t
          where worker_host_id = $1 order by command_id`,
        [worker.registration.workerHostId],
      )).rows,
    });
    const compacted = await logRows();
    assertEquals(
      compacted.commands.map((r) => (r.row as { id: string }).id).sort(),
      [pendingId, recentId].sort(),
    );
    assertEquals(
      compacted.tombstones.map((r) =>
        (r.row as { command_id: string }).command_id
      )
        .sort(),
      [...compactedIds].sort(),
    );
    const digestsBefore = await tableDigests(database);
    assertNotEquals(digestsBefore.get("worker_commands"), "empty");
    assertNotEquals(
      digestsBefore.get("worker_command_ack_tombstones"),
      "empty",
    );

    await fenceAndReenable(fixture);

    assertEquals(
      changedTables(digestsBefore, await tableDigests(database)),
      [],
    );
    assertEquals(await logRows(), compacted);

    await withPgTransaction(
      database,
      (transaction) => sweepExecutionRetention(transaction),
    );
    assertEquals(await logRows(), compacted);
    const resurrected = await database.query(
      `select 1 from bakery.worker_commands where id = any($1::uuid[])`,
      [compactedIds],
    );
    assertEquals(resurrected.rowCount, 0);
  }));

Deno.test("AC2: a restore keeps a compacted draft epoch row for row, and compacting it again removes nothing", () =>
  withRestoreFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    const job = await seedEligibleJob(
      database,
      fixture.organizationId,
      fixture.principalId,
    );
    const artifactId = (await database.query<{ id: string }>(
      `insert into bakery.artifacts
         (organization_id, task_id, artifact_type, name)
       values ($1, $2, 'plan', 'f1 compacted draft') returning id`,
      [fixture.organizationId, job.taskId],
    )).rows[0].id;
    const draftId = crypto.randomUUID();
    const epoch = 2;
    await database.query(
      `insert into bakery.artifact_drafts
         (id, organization_id, artifact_id, task_id, epoch, server_sequence,
          status)
       values ($1, $2, $3, $4, $5, 5, 'active')`,
      [draftId, fixture.organizationId, artifactId, job.taskId, epoch],
    );
    const checkpointIds: string[] = [];
    for (let sequence = 0; sequence <= 5; sequence++) {
      const text = `f1 draft text ${sequence}`;
      checkpointIds.push(
        (await database.query<{ id: string }>(
          `insert into bakery.artifact_draft_checkpoints
           (organization_id, draft_id, epoch, server_sequence, state, frontiers,
            text_content, text_digest)
         values ($1, $2, $3, $4, '\\x01', '\\x02', $5, $6) returning id`,
          [
            fixture.organizationId,
            draftId,
            epoch,
            sequence,
            text,
            await sha256Bytes(new TextEncoder().encode(text)),
          ],
        )).rows[0].id,
      );
    }
    await database.query(
      `update bakery.artifact_drafts set current_checkpoint_id = $2 where id = $1`,
      [draftId, checkpointIds[5]],
    );
    const updateIds: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) {
      updateIds.push(
        (await database.query<{ id: string }>(
          `insert into bakery.artifact_draft_updates
           (organization_id, draft_id, epoch, server_sequence, mutation_id,
            actor_id, update_bytes, update_digest)
         values ($1, $2, $3, $4, $5, $6, '\\x03', 'digest') returning id`,
          [
            fixture.organizationId,
            draftId,
            epoch,
            sequence,
            crypto.randomUUID(),
            fixture.principalId,
          ],
        )).rows[0].id,
      );
    }
    for (const sequence of [1, 2]) {
      await database.query(
        `insert into bakery.artifact_draft_receipts
           (organization_id, draft_id, mutation_id, request_digest, actor_id,
            epoch, server_sequence, checkpoint_id, update_id, update_digest,
            text_digest, committed_at)
         values ($1, $2, $3, 'request', $4, $5, $6, $7, $8, 'digest', 'digest',
                 clock_timestamp() - interval '2 days')`,
        [
          fixture.organizationId,
          draftId,
          crypto.randomUUID(),
          fixture.principalId,
          epoch,
          sequence,
          checkpointIds[sequence],
          updateIds[sequence - 1],
        ],
      );
    }
    const removed = await withPgTransaction(
      database,
      (transaction) =>
        compactDraftEpoch(transaction, fixture.organizationId, draftId, epoch, {
          keptCheckpoints: 2,
        }),
    );
    assertEquals(removed, { receipts: 2, updates: 4, checkpoints: 4 });
    const digestsBefore = await tableDigests(database);
    for (
      const table of [
        "artifact_drafts",
        "artifact_draft_checkpoints",
        "artifact_draft_updates",
      ]
    ) {
      assertNotEquals(digestsBefore.get(table), "empty", `${table} is seeded`);
    }
    const kept = async () =>
      (await database.query<{ id: string }>(
        `select id from bakery.artifact_draft_checkpoints
        where draft_id = $1 order by server_sequence`,
        [draftId],
      )).rows.map((row) => row.id);
    assertEquals(await kept(), [checkpointIds[4], checkpointIds[5]]);

    await fenceAndReenable(fixture);

    assertEquals(
      changedTables(digestsBefore, await tableDigests(database)),
      [],
    );
    assertEquals(await kept(), [checkpointIds[4], checkpointIds[5]]);
    const again = await withPgTransaction(
      database,
      (transaction) =>
        compactDraftEpoch(transaction, fixture.organizationId, draftId, epoch, {
          keptCheckpoints: 2,
        }),
    );
    assertEquals(again, { receipts: 0, updates: 0, checkpoints: 0 });
    assertEquals(await kept(), [checkpointIds[4], checkpointIds[5]]);
  }));

const MANIFEST_SQL = (() => {
  const script = Deno.readTextFileSync(
    new URL("../../scripts/deploy/backup.sh", import.meta.url),
  );
  const found = /references_sql="([^"]*)"\ncounts_sql=/.exec(script);
  if (found === null) throw new Error("backup.sh has no references_sql");
  return found[1];
})();

type References = {
  storageBackend: string;
  skillFiles: {
    organizationId: string;
    skillVersionId: string;
    objectKey: string;
    sizeBytes: number;
    sha256: string;
  }[];
  blobs: {
    organizationId: string;
    sha256: string;
    sizeBytes: number;
    objectKey: string;
  }[];
};

const readReferences = async (database: Database) =>
  (await database.query<{ references: References }>(
    `select (${MANIFEST_SQL}) as "references"`,
  )).rows[0].references;

Deno.test("AC2: every object key and digest the backup manifest records still resolves after a restore, and none dangles", () =>
  withRestoreFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    const organizationId = fixture.organizationId;
    const job = await seedEligibleJob(
      database,
      organizationId,
      fixture.principalId,
    );
    const sourceId = crypto.randomUUID();
    const skillId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await database.query(
      `insert into bakery.skill_sources
         (id, organization_id, source_type, locator, display_name)
       values ($1, $2, 'upload', $3, 'f1 source')`,
      [sourceId, organizationId, `f1-${sourceId}`],
    );
    await database.query(
      `insert into bakery.skills (id, organization_id, source_id, slug, name)
       values ($1, $2, $3, $4, 'f1 skill')`,
      [skillId, organizationId, sourceId, `f1-${skillId}`],
    );
    await database.query(
      `insert into bakery.skill_versions
         (id, organization_id, skill_id, revision, source_revision, digest,
          entry_path, manifest, status, created_by)
       values ($1, $2, $3, 1, 'r1', 'sha256:f1', 'SKILL.md', '{}'::jsonb,
               'published', $4)`,
      [versionId, organizationId, skillId, fixture.principalId],
    );
    await database.query(
      `update bakery.skills set active_version_id = $2 where id = $1`,
      [skillId, versionId],
    );
    const fileHashes: string[] = [];
    for (const path of ["SKILL.md", "scripts/run.sh"]) {
      const hash = await sha256Bytes(new TextEncoder().encode(`f1 ${path}`));
      fileHashes.push(hash);
      await database.query(
        `insert into bakery.skill_files
           (organization_id, skill_version_id, path, media_type, object_key,
            size_bytes, sha256, is_executable)
         values ($1, $2, $3, 'text/plain', $4, 12, $5, false)`,
        [
          organizationId,
          versionId,
          path,
          `organizations/${organizationId}/skills/${versionId}/${hash}`,
          hash,
        ],
      );
    }
    const blobHashes: string[] = [];
    for (const name of ["one", "two"]) {
      const hash = await sha256Bytes(
        new TextEncoder().encode(`f1 blob ${name}`),
      );
      blobHashes.push(hash);
      await database.query(
        `insert into bakery.blobs
           (organization_id, sha256, size_bytes, media_type, created_by_id)
         values ($1, $2, 14, 'application/octet-stream', $3)`,
        [organizationId, hash, fixture.principalId],
      );
    }
    const content = new TextEncoder().encode("f1 artifact body");
    const artifactId = (await database.query<{ id: string }>(
      `insert into bakery.artifacts
         (organization_id, task_id, artifact_type, name)
       values ($1, $2, 'plan', 'f1 referenced artifact') returning id`,
      [organizationId, job.taskId],
    )).rows[0].id;
    const artifactVersionId = (await database.query<{ id: string }>(
      `insert into bakery.artifact_versions
         (organization_id, artifact_id, task_id, author_id, revision, content,
          sha256, size_bytes, media_type)
       values ($1, $2, $3, $4, 1, $5, $6, $7, 'text/plain') returning id`,
      [
        organizationId,
        artifactId,
        job.taskId,
        fixture.principalId,
        content,
        await sha256Bytes(content),
        content.byteLength,
      ],
    )).rows[0].id;
    await database.query(
      `update bakery.artifacts set current_version_id = $2 where id = $1`,
      [artifactId, artifactVersionId],
    );

    const manifestBefore = await readReferences(database);
    assertEquals(
      manifestBefore.skillFiles.filter((f) => f.skillVersionId === versionId)
        .map((f) => f.sha256).sort(),
      [...fileHashes].sort(),
    );
    assertEquals(
      manifestBefore.blobs.filter((b) => b.organizationId === organizationId)
        .map((b) => b.sha256).sort(),
      [...blobHashes].sort(),
    );
    const digestsBefore = await tableDigests(database);

    await fenceAndReenable(fixture);

    assertEquals(
      changedTables(digestsBefore, await tableDigests(database)),
      [],
    );
    const manifestAfter = await readReferences(database);
    assertEquals(
      JSON.stringify(manifestAfter),
      JSON.stringify(manifestBefore),
    );
    for (const file of manifestAfter.skillFiles) {
      const owner = await database.query(
        `select 1 from bakery.skill_files f
           join bakery.skill_versions v
             on v.organization_id = f.organization_id
            and v.id = f.skill_version_id
          where f.organization_id = $1 and f.skill_version_id = $2
            and f.object_key = $3 and f.sha256 = $4`,
        [file.organizationId, file.skillVersionId, file.objectKey, file.sha256],
      );
      assertEquals(owner.rowCount, 1, `${file.objectKey} dangles`);
    }
    for (const blob of manifestAfter.blobs) {
      assertEquals(
        blob.objectKey,
        `organizations/${blob.organizationId}/blobs/sha256/${blob.sha256}`,
      );
      const owner = await database.query(
        `select 1 from bakery.blobs
          where organization_id = $1 and sha256 = $2`,
        [blob.organizationId, blob.sha256],
      );
      assertEquals(owner.rowCount, 1, `${blob.objectKey} dangles`);
    }
    const current = await database.query<{ matches: boolean }>(
      `select v.sha256 = $3 as matches
         from bakery.artifacts a
         join bakery.artifact_versions v
           on v.organization_id = a.organization_id
          and v.artifact_id = a.id and v.id = a.current_version_id
        where a.organization_id = $1 and a.id = $2`,
      [organizationId, artifactId, await sha256Bytes(content)],
    );
    assertEquals(current.rows, [{ matches: true }]);
  }));
