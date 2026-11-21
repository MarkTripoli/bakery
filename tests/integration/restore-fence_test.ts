import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { applyRestoreFence } from "../../apps/server/src/modules/backups/restore-fence.ts";
import {
  assertNotQuiesced,
  isQuiesced,
} from "../../apps/server/src/platform/maintenance.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  removeSeededEffects,
  seedEffect,
} from "../helpers/external-effects-seed.ts";
import {
  registeredWorker,
  seedEligibleJob,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedLegacyLeasedModelAttempt } from "../helpers/worker-execution/legacy-attempt.ts";
import {
  eventBody,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";

/**
 * #64 slice E1 (also #49) against real Postgres: the restore fence. After the
 * stores of a backup are restored, the fence holds every unsettled effect as
 * uncertain, quarantines every active attempt and moves its job's fence, revokes
 * every worker host, and writes the restore record that keeps the installation
 * closed. The proof that an effect is never sent again is in the executor test.
 */

const SET = "20261121T030000Z-restore-test";

const fence = (fixture: WorkerFixture, cutoffAt: string | null = null) =>
  withPgTransaction(
    fixture.pgDatabase,
    (transaction) =>
      applyRestoreFence(transaction, { backupName: SET, cutoffAt }),
  );

/** Removes what these tests add outside the fixture's own cleanup. */
async function cleanup(fixture: WorkerFixture) {
  await removeSeededEffects(fixture.pgDatabase);
  await fixture.pgDatabase.query(`delete from bakery.installation_restores`);
}

async function withFixture<T>(work: (fixture: WorkerFixture) => Promise<T>) {
  return await withWorkerFixture(async (fixture) => {
    await cleanup(fixture);
    try {
      return await work(fixture);
    } finally {
      await cleanup(fixture);
    }
  });
}

/** A worker reports an event on its attempt, as the worker protocol does. */
const postEvent = (
  fixture: WorkerFixture,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
  assignment: { attemptId: string; leaseToken: string; fence: string },
  localSeq = "1",
) => {
  const eventId = crypto.randomUUID();
  return workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/events`,
    eventBody(assignment, eventId, localSeq),
    { idempotencyKey: eventId },
  );
};

const claimBody = (workerHostId: string) => {
  const claimKey = crypto.randomUUID();
  return {
    claimKey,
    body: {
      claimKey,
      workerHostId,
      capabilities: workerFixtureCapabilities,
    },
  };
};

Deno.test("the fence quarantines a real claimed attempt, moves the job's fence and revokes the worker; the old holder is refused", () =>
  withFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "restore-fence-holder",
    });
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    // A genuinely leased attempt: the same rows a claim leaves behind.
    const assignment = await seedLegacyLeasedModelAttempt(
      fixture,
      worker,
      job.jobId,
    );
    // Before the restore the holder reports normally.
    const before = await postEvent(fixture, worker, assignment);
    assert(
      before.ok,
      `the holder reported before the restore: ${before.status}`,
    );
    await before.body?.cancel();

    const result = await fence(fixture, "2026-11-21T03:00:05.000Z");
    assertEquals(result.attemptsQuarantined, 1);
    assertEquals(result.jobsAwaitingReconciliation, 1);
    assert(result.workersRevoked >= 1);

    const state = await fixture.pgDatabase.query<{
      attempt: string;
      job: string;
      fence: string;
      current: string;
      host: string;
      mode: string;
    }>(
      `select attempt.status as attempt, job.status as job,
              attempt.fence::text as fence,
              job.current_fence::text as current,
              host.status as host, host.desired_mode as mode
         from bakery.job_attempts attempt
         join bakery.jobs job on job.id = attempt.job_id
         join bakery.worker_hosts host on host.id = attempt.worker_host_id
        where attempt.id = $1`,
      [assignment.attemptId],
    );
    assertEquals(state.rows[0].attempt, "quarantined");
    assertEquals(state.rows[0].job, "awaiting_reconciliation");
    assertEquals(
      BigInt(state.rows[0].current),
      BigInt(state.rows[0].fence) + 1n,
      "the job's fence moved past the old holder's",
    );
    assertEquals([state.rows[0].host, state.rows[0].mode], [
      "revoked",
      "revoked",
    ]);

    // The old holder is refused: its host is revoked, so it must enrol again.
    const after = await postEvent(fixture, worker, assignment, "2");
    assert([401, 403, 409].includes(after.status), `${after.status}`);
    await after.body?.cancel();

    // The record says what the fence did, and nothing about any content.
    const record = await fixture.pgDatabase.query<{
      id: string;
      backup_name: string;
      cutoff_at: Date | null;
      attempts: number;
      workers: number;
      released_at: Date | null;
    }>(
      `select id, backup_name, cutoff_at, attempts_quarantined as attempts,
              workers_revoked as workers, released_at
         from bakery.installation_restores`,
    );
    assertEquals(record.rows.length, 1);
    assertEquals(record.rows[0].id, result.restoreId);
    assertEquals(record.rows[0].backup_name, SET);
    assertEquals(record.rows[0].attempts, 1);
    assertEquals(record.rows[0].released_at, null);
    assertEquals(
      record.rows[0].cutoff_at?.toISOString(),
      "2026-11-21T03:00:05.000Z",
    );
  }));

Deno.test("the fence holds prepared and submitted effects and leaves settled and already-uncertain ones alone", () =>
  withFixture(async (fixture) => {
    const org = fixture.organizationId;
    const prepared = await seedEffect(
      fixture.pgDatabase,
      org,
      "prepared",
      "op.a",
    );
    const submitted = await seedEffect(
      fixture.pgDatabase,
      org,
      "submitted",
      "op.b",
    );
    const uncertain = await seedEffect(
      fixture.pgDatabase,
      org,
      "uncertain",
      "op.c",
    );
    const confirmed = await seedEffect(
      fixture.pgDatabase,
      org,
      "confirmed",
      "op.d",
    );
    const before = await fixture.pgDatabase.query<{ id: string; v: number }>(
      `select id, version as v from bakery.external_effects
        where id = any($1::uuid[])`,
      [[uncertain, confirmed]],
    );
    const result = await fence(fixture);
    assertEquals(result.effectsHeld, 2);

    const rows = await fixture.pgDatabase.query<{
      id: string;
      status: string;
      evidence: { previousStatus?: string; restoreId?: string } | null;
    }>(
      `select id, status, reconciliation_evidence as evidence
         from bakery.external_effects where id = any($1::uuid[])`,
      [[prepared, submitted, uncertain, confirmed]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    assertEquals(byId.get(prepared)!.status, "uncertain");
    assertEquals(byId.get(prepared)!.evidence?.previousStatus, "prepared");
    assertEquals(byId.get(submitted)!.status, "uncertain");
    assertEquals(byId.get(submitted)!.evidence?.previousStatus, "submitted");
    assertEquals(byId.get(prepared)!.evidence?.restoreId, result.restoreId);
    // Settled, and already unknown, are not touched: same version, same status.
    assertEquals(byId.get(confirmed)!.status, "confirmed");
    assertEquals(byId.get(uncertain)!.evidence, null);
    const after = await fixture.pgDatabase.query<{ id: string; v: number }>(
      `select id, version as v from bakery.external_effects
        where id = any($1::uuid[])`,
      [[uncertain, confirmed]],
    );
    assertEquals(
      new Map(after.rows.map((row) => [row.id, row.v])),
      new Map(before.rows.map((row) => [row.id, row.v])),
    );
    // The evidence carries no target and no argument.
    const evidence = JSON.stringify(byId.get(prepared)!.evidence);
    assert(!evidence.includes("secret-target"), evidence);
  }));

Deno.test("while the restore is held every guarded door refuses with a non-retryable 503, and it opens when the record is released", () =>
  withFixture(async (fixture) => {
    // A worker registered before the restore is revoked by it; a new one enrols
    // after, as an operator would, and finds the door shut.
    const old = await registeredWorker(fixture, { name: "restore-old" });
    await fence(fixture);

    await withPgTransaction(fixture.pgDatabase, async (transaction) => {
      const error = await assertRejects(() =>
        assertNotQuiesced(transaction, "intake")
      );
      assert(error instanceof StandardError);
      assertEquals(error.code, "INSTALLATION_RESTORING");
      // The route consumers leave their work alone while held.
      assertEquals(await isQuiesced(transaction, "intake"), true);
    });

    const fresh = await registeredWorker(fixture, { name: "restore-fresh" });
    await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      { priority: 100 },
    );
    const held = claimBody(fresh.registration.workerHostId);
    const refused = await workerRequest(
      fixture,
      fresh.credential,
      "/v1/worker/claims",
      held.body,
      { idempotencyKey: held.claimKey },
    );
    assertEquals(refused.status, 503);
    const problem = await refused.json() as {
      code: string;
      retryable: boolean;
    };
    assertEquals(problem.code, "INSTALLATION_RESTORING");
    assertEquals(problem.retryable, false);
    // Nothing was claimed.
    assertEquals(
      (await fixture.pgDatabase.query(
        `select 1 from bakery.job_attempts where worker_host_id = $1`,
        [fresh.registration.workerHostId],
      )).rows.length,
      0,
    );
    void old;

    // An administrator completes the steps (slice E3): the record is released.
    await fixture.pgDatabase.query(
      `update bakery.installation_restores set released_at = now()`,
    );
    await withPgTransaction(fixture.pgDatabase, async (transaction) => {
      await assertNotQuiesced(transaction, "intake");
      assertEquals(await isQuiesced(transaction, "intake"), false);
    });
    const open = claimBody(fresh.registration.workerHostId);
    const claimed = await workerRequest(
      fixture,
      fresh.credential,
      "/v1/worker/claims",
      open.body,
      { idempotencyKey: open.claimKey },
    );
    // The door is open: the claim is processed, and no work is claimable for
    // this worker, so it answers "nothing to do" and not the restore refusal.
    assertEquals(claimed.status, 204, await claimed.clone().text());
    await claimed.body?.cancel();
  }));

Deno.test("the fence is one transaction: if anything fails after it ran, nothing changed and no record exists", () =>
  withFixture(async (fixture) => {
    const effect = await seedEffect(
      fixture.pgDatabase,
      fixture.organizationId,
      "prepared",
      "op.atomic",
    );
    const worker = await registeredWorker(fixture, { name: "restore-atomic" });
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await seedLegacyLeasedModelAttempt(
      fixture,
      worker,
      job.jobId,
    );

    await assertRejects(
      () =>
        withPgTransaction(fixture.pgDatabase, async (transaction) => {
          const result = await applyRestoreFence(transaction, {
            backupName: SET,
            cutoffAt: null,
          });
          assertEquals(result.attemptsQuarantined, 1);
          throw new Error("RESTORE_STEP_AFTER_FENCE_FAILED");
        }),
      Error,
      "RESTORE_STEP_AFTER_FENCE_FAILED",
    );

    const status = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.external_effects where id = $1`,
      [effect],
    );
    assertEquals(status.rows[0].status, "prepared");
    const attempt = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.job_attempts where id = $1`,
      [assignment.attemptId],
    );
    assertEquals(attempt.rows[0].status, "leased");
    const host = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.worker_hosts where id = $1`,
      [worker.registration.workerHostId],
    );
    assertEquals(host.rows[0].status !== "revoked", true);
    assertEquals(
      (await fixture.pgDatabase.query(
        `select 1 from bakery.installation_restores`,
      )).rows.length,
      0,
    );
  }));

Deno.test("the restore is audited with counts and the set's name only", () =>
  withFixture(async (fixture) => {
    await seedEffect(
      fixture.pgDatabase,
      fixture.organizationId,
      "prepared",
      "op.audit",
    );
    const result = await fence(fixture);
    const rows = await fixture.pgDatabase.query<{ details: unknown }>(
      `select details from bakery.audit_events
        where operation = 'installation.restore' and resource_id = $1`,
      [result.restoreId],
    );
    assertEquals(rows.rows.length, 1);
    const text = JSON.stringify(rows.rows[0].details);
    assert(text.includes(SET));
    assert(!text.includes("secret-target"), "no effect target in the audit");
    assertEquals(
      (rows.rows[0].details as { effectsHeld: number }).effectsHeld,
      1,
    );
  }));
