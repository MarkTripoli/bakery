import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  assertQuiesced,
  holdInstallation,
  type HoldOptions,
  letGoInstallation,
} from "../helpers/installation-maintenance.ts";
import {
  admitPresetRun,
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";

/**
 * #64 slice B against real Postgres: the maintenance switch a backup holds, the
 * entry points it closes (run start and worker claim here; webhook intake,
 * imports and collection in installation-maintenance-entry-points_test.ts),
 * and the runner protocol that enters it, waits for quiet and lets go.
 */

const ENTER = "backupRunner.maintenance.enter";
const EXIT = "backupRunner.maintenance.exit";

async function reset(f: WorkerFixture) {
  // The switch row points at a backup run, so it goes first.
  await f.pgDatabase.query("delete from bakery.installation_maintenance");
  await f.pgDatabase.query("delete from bakery.backup_runs");
  await f.pgDatabase.query("delete from bakery.backup_runner_credentials");
}

const withFixture = <T>(work: (f: WorkerFixture) => Promise<T>) =>
  withWorkerFixture(async (f) => {
    await reset(f);
    try {
      return await work(f);
    } finally {
      await reset(f);
    }
  }, { env: presetBudgetEnv });

const hold = (f: WorkerFixture, options?: HoldOptions) =>
  holdInstallation(f.pgDatabase, options);
const letGo = (f: WorkerFixture) => letGoInstallation(f.pgDatabase);

type Counts = Record<string, string>;
/** Everything a refused call must leave alone, as one comparable snapshot. */
async function snapshot(f: WorkerFixture, taskId: string): Promise<Counts> {
  const result = await f.pgDatabase.query<Counts>(
    `select
       (select count(*)::text from bakery.workflow_runs) as runs,
       (select count(*)::text from bakery.jobs) as jobs,
       (select count(*)::text from bakery.job_attempts) as attempts,
       (select count(*)::text from bakery.domain_events) as events,
       (select count(*)::text from bakery.outbox) as outbox,
       (select status from bakery.tasks where id = $1) as "taskStatus"`,
    [taskId],
  );
  return result.rows[0];
}

async function startableTask(f: WorkerFixture) {
  const agent = await seedFundedCodingAgent(
    f,
    f,
    `maint-${crypto.randomUUID().slice(0, 8)}`,
  );
  const repository = await seedPresetRepository(f.pgDatabase, f, {
    agentVersionId: agent,
  });
  const task = await createPresetTask(f, f, repository);
  return { repository, task };
}

type RunBody = { id: string; status: string; workflowVersionId: string };

/** A request as the host runner sends it: the runner credential, never a session. */
function runnerCall(
  f: WorkerFixture,
  credential: string | null,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const headers = new Headers({
    "content-type": "application/json",
    origin: authTestOrigin,
  });
  if (credential !== null) headers.set("authorization", `Bearer ${credential}`);
  if (cookie) headers.set("cookie", cookie);
  return f.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** Issues the runner credential, asks for a backup and claims it as the runner would. */
async function claimedBackup(f: WorkerFixture) {
  const issued = await expectJson<{ credential: string }>(
    await apiCall(f, f, "POST", "/v1/installation/backup-runner/credential", {
      body: {},
    }),
    201,
  );
  await expectJson(
    await apiCall(f, f, "POST", "/v1/installation/backups", { body: {} }),
    202,
  );
  const claim = await (await runnerCall(
    f,
    issued.credential,
    "/v1/backup-runner/claims",
  )).json() as { claimed: boolean; runId: string; leaseToken: string };
  assertEquals(claim.claimed, true);
  return {
    credential: issued.credential,
    runId: claim.runId,
    leaseToken: claim.leaseToken,
    maintain: (token = claim.leaseToken, credential = issued.credential) =>
      runnerCall(
        f,
        credential,
        `/v1/backup-runner/runs/${claim.runId}/maintenance`,
        { leaseToken: token },
      ),
    report: (body: Record<string, unknown>) =>
      runnerCall(
        f,
        issued.credential,
        `/v1/backup-runner/runs/${claim.runId}/reports`,
        { leaseToken: claim.leaseToken, ...body },
      ),
  };
}

type MaintenanceBody = {
  state: string;
  runId: string;
  leaseExpiresAt: string;
  liveAttempts: number;
  openTransactions: number;
  retryAfterSeconds: number;
};

async function auditRows(f: WorkerFixture, operation: string, runId: string) {
  return (await f.pgDatabase.query<
    { operation: string; details: Record<string, unknown> }
  >(
    `select operation, details from bakery.audit_events
      where operation = $1 and details->>'runId' = $2 order by created_at, id`,
    [operation, runId],
  )).rows;
}

async function maintenanceRow(f: WorkerFixture) {
  return (await f.pgDatabase.query<
    { state: string; ownerRunId: string | null }
  >(
    `select state, owner_run_id as "ownerRunId"
       from bakery.installation_maintenance where id = true`,
  )).rows[0];
}

// (b) entry point: run admission.
Deno.test("while the installation is held a run start answers 503 INSTALLATION_QUIESCED with Retry-After and commits nothing", () =>
  withFixture(async (f) => {
    const { repository, task } = await startableTask(f);
    for (const state of ["draining", "quiesced"] as const) {
      await hold(f, { state });
      const before = await snapshot(f, task.id);
      await assertQuiesced(await startPresetRun(f, f, task, repository));
      // Nothing was created or changed: no run, no event, no outbox row, and
      // the task is still a draft that can start once the hold ends.
      assertEquals(await snapshot(f, task.id), before, state);
      assertEquals(before.taskStatus, "draft");
    }
    await letGo(f);
    const run = await expectJson<RunBody>(
      await startPresetRun(f, f, task, repository),
      201,
    );
    assertEquals(run.status, "queued");
    const after = await snapshot(f, task.id);
    assertEquals(after.taskStatus !== "draft", true);
  }));

// (b) entry point: new worker claims.
Deno.test("while the installation is held a worker claim answers 503 INSTALLATION_QUIESCED with Retry-After and leases nothing", () =>
  withFixture(async (f) => {
    const { repository, task } = await startableTask(f);
    const run = await expectJson<RunBody>(
      await startPresetRun(f, f, task, repository),
      201,
    );
    const admitted = await admitPresetRun(f.pgDatabase, f, run);
    const worker = await registeredWorker(f, {
      name: `maint-claim-${crypto.randomUUID().slice(0, 8)}`,
      capabilities: workerFixtureCapabilities,
    });
    const claimBody = () => {
      const claimKey = crypto.randomUUID();
      return {
        claimKey,
        body: {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities: workerFixtureCapabilities,
          supportedActions: ["harness.implement"],
        },
      };
    };
    const claim = (
      { claimKey, body }: ReturnType<typeof claimBody>,
    ) =>
      workerRequest(f, worker.credential, "/v1/worker/claims", body, {
        idempotencyKey: claimKey,
      });

    await hold(f, { state: "quiesced" });
    const before = await snapshot(f, task.id);
    await assertQuiesced(await claim(claimBody()));
    // No attempt was leased and the job is untouched.
    assertEquals(await snapshot(f, task.id), before);
    const job = await f.pgDatabase.query<{ status: string }>(
      "select status from bakery.jobs where id = $1",
      [admitted.implementJobId],
    );
    assertEquals(job.rows[0].status, "queued");

    // The same worker is served the same job the moment the hold ends.
    await letGo(f);
    const served = await claim(claimBody());
    assertEquals(served.status, 200, await served.clone().text());
    const assignment = await served.json() as { jobId: string };
    assertEquals(assignment.jobId, admitted.implementJobId);
  }));

// (c) reads, admin routes and the runner routes stay up.
Deno.test("while the installation is quiesced reads, administrator routes and the runner routes stay up", () =>
  withFixture(async (f) => {
    const { task } = await startableTask(f);
    const backup = await claimedBackup(f);
    await hold(f, { state: "quiesced", ownerRunId: backup.runId });

    // Reads: a task and the task list.
    const read = await apiCall(f, f, "GET", `/v1/tasks/${task.id}`);
    assertEquals(read.status, 200, await read.clone().text());
    await read.body?.cancel();
    const list = await apiCall(f, f, "GET", "/v1/tasks");
    assertEquals(list.status, 200);
    await list.body?.cancel();

    // The administrator's backup routes: the list, and the status that says why.
    const runs = await apiCall(f, f, "GET", "/v1/installation/backups");
    assertEquals(runs.status, 200);
    await runs.body?.cancel();
    const status = await expectJson<
      { maintenanceState: string; maintenanceSince: string | null }
    >(await apiCall(f, f, "GET", "/v1/installation/backups/status"), 200);
    assertEquals(status.maintenanceState, "quiesced");
    assert(status.maintenanceSince !== null);

    // The runner's routes: the claim, the maintenance check and a report.
    const claim = await runnerCall(
      f,
      backup.credential,
      "/v1/backup-runner/claims",
    );
    assertEquals(claim.status, 200);
    await claim.body?.cancel();
    const check = await backup.maintain();
    assertEquals(check.status, 200, await check.clone().text());
    assertEquals((await check.json() as MaintenanceBody).state, "quiesced");
    const report = await backup.report({
      sequence: 1,
      status: "running",
      progressPercent: 10,
    });
    assertEquals(report.status, 200, await report.clone().text());
    await report.body?.cancel();
  }));

// (a) the lease ends the hold with no runner action.
Deno.test("a hold whose lease ends returns the installation to normal with no runner action", () =>
  withFixture(async (f) => {
    const { repository, task } = await startableTask(f);
    await hold(f, { state: "quiesced", leaseSeconds: 2 });
    const refused = await startPresetRun(f, f, task, repository);
    await assertQuiesced(refused);
    // The retry hint is never longer than what is left of the lease.
    assert(Number(refused.headers.get("retry-after")) <= 2);
    const held = await expectJson<{ maintenanceState: string }>(
      await apiCall(f, f, "GET", "/v1/installation/backups/status"),
      200,
    );
    assertEquals(held.maintenanceState, "quiesced");

    // Nobody lets go and nobody reports; the lease simply passes.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    assertEquals((await maintenanceRow(f)).state, "quiesced");
    const lapsed = await expectJson<
      { maintenanceState: string; maintenanceSince: string | null }
    >(await apiCall(f, f, "GET", "/v1/installation/backups/status"), 200);
    assertEquals(lapsed.maintenanceState, "off");
    assertEquals(lapsed.maintenanceSince, null);
    const run = await expectJson<RunBody>(
      await startPresetRun(f, f, task, repository),
      201,
    );
    assertEquals(run.status, "queued");
  }));

Deno.test("only the runner credential holds the installation, and only for the run whose lease token it presents", () =>
  withFixture(async (f) => {
    const backup = await claimedBackup(f);
    const path = `/v1/backup-runner/runs/${backup.runId}/maintenance`;
    const body = { leaseToken: backup.leaseToken };

    // No credential, an administrator's session, and a wrong credential.
    const none = await runnerCall(f, null, path, body);
    assertEquals(none.status, 401);
    await none.body?.cancel();
    const session = await runnerCall(f, null, path, body, f.adminCookie);
    assertEquals(session.status, 401);
    await session.body?.cancel();
    const wrong = await runnerCall(f, "not-the-credential", path, body);
    assertEquals(wrong.status, 403);
    await wrong.body?.cancel();
    // A wrong lease token, a bad body, and an unknown run.
    const token = await backup.maintain("x".repeat(43));
    assertEquals(token.status, 403);
    await token.body?.cancel();
    const bad = await runnerCall(f, backup.credential, path, { nope: 1 });
    assert(bad.status === 400 || bad.status === 422, `${bad.status}`);
    await bad.body?.cancel();
    const unknown = await runnerCall(
      f,
      backup.credential,
      `/v1/backup-runner/runs/${crypto.randomUUID()}/maintenance`,
      body,
    );
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
    // None of that held the installation.
    assertEquals(await maintenanceRow(f), undefined);
    assertEquals((await auditRows(f, ENTER, backup.runId)).length, 0);

    // The right credential and token: held.
    const entered = await backup.maintain();
    assertEquals(entered.status, 200, await entered.clone().text());
    assertEquals((await entered.json() as MaintenanceBody).state, "draining");
    assertEquals((await maintenanceRow(f)).ownerRunId, backup.runId);

    // The run's own lease ending ends its right to hold (409), and so does
    // another run holding the installation.
    await f.pgDatabase.query(
      "update bakery.backup_runs set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [backup.runId],
    );
    const expired = await backup.maintain();
    assertEquals(expired.status, 409);
    assertEquals(
      (await expired.json() as { reason: string }).reason,
      "lease_expired",
    );
  }));

Deno.test("entering is safe to repeat: one hold, one enter audit row, and the same answer family", () =>
  withFixture(async (f) => {
    const backup = await claimedBackup(f);
    const first = await (await backup.maintain()).json() as MaintenanceBody;
    const second = await (await backup.maintain()).json() as MaintenanceBody;
    assertEquals(first.state, "draining");
    assertEquals(second.state, "draining");
    assertEquals(second.runId, backup.runId);
    // Held once, and audited once.
    assertEquals((await auditRows(f, ENTER, backup.runId)).length, 1);
    const rows = await f.pgDatabase.query<{ n: string }>(
      "select count(*)::text as n from bakery.installation_maintenance",
    );
    assertEquals(rows.rows[0].n, "1");
    // The hold's lease follows the run's claim.
    const lease = await f.pgDatabase.query<{ same: boolean }>(
      `select m.lease_expires_at = r.lease_expires_at as same
         from bakery.installation_maintenance m, bakery.backup_runs r
        where r.id = $1`,
      [backup.runId],
    );
    assertEquals(lease.rows[0].same, true);
  }));

Deno.test("another run's live hold refuses a second hold with maintenance_held", () =>
  withFixture(async (f) => {
    const backup = await claimedBackup(f);
    // A different run, finished long ago, still shown as the owner of a live hold.
    const other = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.backup_runs (id, trigger_kind, status, requested_at, finished_at)
       values ($1, 'manual', 'completed', now() - interval '1 day', now() - interval '1 day')`,
      [other],
    );
    await hold(f, { state: "quiesced", ownerRunId: other });
    const refused = await backup.maintain();
    assertEquals(refused.status, 409);
    assertEquals(
      (await refused.json() as { reason: string }).reason,
      "maintenance_held",
    );
    // The other run still holds it; nothing changed.
    assertEquals((await maintenanceRow(f)).ownerRunId, other);
    assertEquals((await auditRows(f, ENTER, backup.runId)).length, 0);
  }));

Deno.test("a live worker attempt keeps the installation draining until it ends", () =>
  withFixture(async (f) => {
    const { repository, task } = await startableTask(f);
    const run = await expectJson<RunBody>(
      await startPresetRun(f, f, task, repository),
      201,
    );
    const admitted = await admitPresetRun(f.pgDatabase, f, run);
    const worker = await registeredWorker(f, {
      name: `maint-live-${crypto.randomUUID().slice(0, 8)}`,
      capabilities: workerFixtureCapabilities,
    });
    const claimKey = crypto.randomUUID();
    const claimed = await workerRequest(
      f,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: workerFixtureCapabilities,
        supportedActions: ["harness.implement"],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(claimed.status, 200, await claimed.clone().text());
    const assignment = await claimed.json() as {
      attemptId: string;
      jobId: string;
    };
    assertEquals(assignment.jobId, admitted.implementJobId);

    const backup = await claimedBackup(f);
    // Enter, then let the settle window pass so only the attempt is in the way.
    const entered = await (await backup.maintain()).json() as MaintenanceBody;
    assertEquals(entered.state, "draining");
    await f.pgDatabase.query(
      "update bakery.installation_maintenance set entered_at = entered_at - interval '10 seconds'",
    );
    const busy = await (await backup.maintain()).json() as MaintenanceBody;
    assertEquals(busy.state, "draining");
    assertEquals(busy.liveAttempts, 1);
    assert(busy.retryAfterSeconds >= 1);

    // The attempt ends: nothing live is left and the answer is quiesced.
    await f.pgDatabase.query(
      `update bakery.job_attempts set status = 'lost', ended_at = current_timestamp
        where id = $1`,
      [assignment.attemptId],
    );
    const quiet = await (await backup.maintain()).json() as MaintenanceBody;
    assertEquals(quiet.state, "quiesced");
    assertEquals(quiet.liveAttempts, 0);
    assertEquals(quiet.retryAfterSeconds, 0);
    assertEquals((await maintenanceRow(f)).state, "quiesced");
    // Once quiesced it stays quiesced on every further ask.
    assertEquals(
      (await (await backup.maintain()).json() as MaintenanceBody).state,
      "quiesced",
    );
  }));

Deno.test("the settle window keeps a just-entered hold draining even with nothing in flight", () =>
  withFixture(async (f) => {
    const backup = await claimedBackup(f);
    const fresh = await (await backup.maintain()).json() as MaintenanceBody;
    assertEquals(fresh.state, "draining");
    assertEquals(fresh.liveAttempts, 0);
    assert(fresh.retryAfterSeconds >= 1);
    await f.pgDatabase.query(
      "update bakery.installation_maintenance set entered_at = entered_at - interval '10 seconds'",
    );
    assertEquals(
      (await (await backup.maintain()).json() as MaintenanceBody).state,
      "quiesced",
    );
  }));

// (d) a drain that never ends: the runner reports drain_timeout and the hold ends.
Deno.test("a drain timeout fails the backup with its code and releases the installation", () =>
  withFixture(async (f) => {
    const { repository, task } = await startableTask(f);
    const backup = await claimedBackup(f);
    await backup.maintain();
    await assertQuiesced(await startPresetRun(f, f, task, repository));

    const failed = await backup.report({
      sequence: 1,
      status: "failed",
      failureCode: "drain_timeout",
      failureDetail:
        "The installation did not go quiet within 10 minutes: 1 worker attempts and 0 open transactions were still in flight. No backup was taken.",
    });
    assertEquals(failed.status, 200, await failed.clone().text());
    const run = await failed.json() as {
      status: string;
      failureCode: string | null;
    };
    assertEquals(run.status, "failed");
    assertEquals(run.failureCode, "drain_timeout");

    // Released: the installation takes work again, the status says so, and the
    // exit is audited with the outcome and the code.
    assertEquals((await maintenanceRow(f)).state, "off");
    const status = await expectJson<
      { maintenanceState: string; state: string }
    >(
      await apiCall(f, f, "GET", "/v1/installation/backups/status"),
      200,
    );
    assertEquals(status.maintenanceState, "off");
    assertEquals(status.state, "failed");
    const exits = await auditRows(f, EXIT, backup.runId);
    assertEquals(exits.length, 1);
    assertEquals(exits[0].details.outcome, "failed");
    assertEquals(exits[0].details.failureCode, "drain_timeout");
    const started = await expectJson<RunBody>(
      await startPresetRun(f, f, task, repository),
      201,
    );
    assertEquals(started.status, "queued");
  }));

Deno.test("a completed backup releases the installation, and a running report extends the hold with the claim", () =>
  withFixture(async (f) => {
    const { repository, task } = await startableTask(f);
    const backup = await claimedBackup(f);
    await backup.maintain();
    // Make the hold's lease short, then a running report extends it with the claim.
    await f.pgDatabase.query(
      "update bakery.installation_maintenance set lease_expires_at = clock_timestamp() + interval '5 seconds'",
    );
    const running = await backup.report({
      sequence: 1,
      status: "running",
      progressPercent: 20,
    });
    assertEquals(running.status, 200, await running.clone().text());
    await running.body?.cancel();
    const extended = await f.pgDatabase.query<{ seconds: number }>(
      `select extract(epoch from (lease_expires_at - clock_timestamp()))::float as seconds
         from bakery.installation_maintenance`,
    );
    assert(extended.rows[0].seconds > 200, `${extended.rows[0].seconds}`);
    await assertQuiesced(await startPresetRun(f, f, task, repository));

    const done = await backup.report({
      sequence: 2,
      status: "completed",
      sizeBytes: "1024",
      locations: ["server-host"],
    });
    assertEquals(done.status, 200, await done.clone().text());
    await done.body?.cancel();
    assertEquals((await maintenanceRow(f)).state, "off");
    const exits = await auditRows(f, EXIT, backup.runId);
    assertEquals(exits.length, 1);
    assertEquals(exits[0].details.outcome, "completed");
    // The terminal report's replay does not write a second exit row.
    const replay = await backup.report({
      sequence: 2,
      status: "completed",
      sizeBytes: "1024",
      locations: ["server-host"],
    });
    assertEquals(replay.status, 200);
    await replay.body?.cancel();
    assertEquals((await auditRows(f, EXIT, backup.runId)).length, 1);
    const started = await expectJson<RunBody>(
      await startPresetRun(f, f, task, repository),
      201,
    );
    assertNotEquals(started.id, undefined);
  }));

Deno.test("a late report cannot revive a hold whose lease already lapsed", () =>
  withFixture(async (f) => {
    const { repository, task } = await startableTask(f);
    const backup = await claimedBackup(f);
    await backup.maintain();
    // The hold's lease lapses while the run's own claim is still good.
    await f.pgDatabase.query(
      "update bakery.installation_maintenance set lease_expires_at = clock_timestamp() - interval '1 second'",
    );
    const running = await backup.report({
      sequence: 1,
      status: "running",
      progressPercent: 30,
    });
    assertEquals(running.status, 200, await running.clone().text());
    await running.body?.cancel();
    // Still off: the report did not put the installation back under maintenance.
    const started = await expectJson<RunBody>(
      await startPresetRun(f, f, task, repository),
      201,
    );
    assertEquals(started.status, "queued");
  }));

// (e) entering and leaving are audited, and never with a secret.
Deno.test("entering and leaving are audited with the runner credential as the actor and no secret in the rows", () =>
  withFixture(async (f) => {
    const backup = await claimedBackup(f);
    await backup.maintain();
    await backup.maintain();
    const done = await backup.report({
      sequence: 1,
      status: "completed",
      sizeBytes: "5",
      locations: ["server-host"],
    });
    assertEquals(done.status, 200, await done.clone().text());
    await done.body?.cancel();

    const rows = await f.pgDatabase.query<{
      operation: string;
      principal_id: string | null;
      organization_id: string | null;
      resource_type: string;
      resource_id: string;
      outcome: string;
      details: Record<string, unknown>;
    }>(
      `select operation, principal_id, organization_id, resource_type,
              resource_id, outcome, details
         from bakery.audit_events
        where operation in ($1, $2) and details->>'runId' = $3
        order by created_at, id`,
      [ENTER, EXIT, backup.runId],
    );
    assertEquals(rows.rows.map((row) => row.operation), [ENTER, EXIT]);
    for (const row of rows.rows) {
      // The runner has no principal and no organization: its credential is the actor.
      assertEquals(row.principal_id, null);
      assertEquals(row.organization_id, null);
      assertEquals(row.resource_type, "backup_runner_credential");
      assertEquals(row.resource_id, "backup-runner");
      assertEquals(row.outcome, "succeeded");
      assertEquals(row.details.reason, "backup");
      assertEquals(row.details.runId, backup.runId);
      assertEquals(typeof row.details.generation, "number");
    }
    assertEquals(rows.rows[0].details.state, "draining");
    assertEquals(rows.rows[1].details.outcome, "completed");
    // Nothing secret: not the credential, not the lease token, not their hashes.
    const everything = JSON.stringify(rows.rows);
    assertEquals(everything.includes(backup.credential), false);
    assertEquals(everything.includes(backup.leaseToken), false);
    for (const word of ["leaseToken", "token", "secret", "password", "key"]) {
      assertEquals(
        Object.keys(rows.rows[0].details).some((k) =>
          k.toLowerCase().includes(word)
        ),
        false,
        word,
      );
    }
  }));

Deno.test("a hold that lapsed is audited as left, the next time anyone enters", () =>
  withFixture(async (f) => {
    const backup = await claimedBackup(f);
    await backup.maintain();
    await f.pgDatabase.query(
      "update bakery.installation_maintenance set lease_expires_at = clock_timestamp() - interval '1 second'",
    );
    // Nothing lapsed in the audit trail yet: a lapse runs no code.
    assertEquals((await auditRows(f, EXIT, backup.runId)).length, 0);
    const again = await backup.maintain();
    assertEquals(again.status, 200, await again.clone().text());
    assertEquals((await again.json() as MaintenanceBody).state, "draining");
    const exits = await auditRows(f, EXIT, backup.runId);
    assertEquals(exits.length, 1);
    assertEquals(exits[0].details.outcome, "lease_expired");
    assertEquals((await auditRows(f, ENTER, backup.runId)).length, 2);
  }));
