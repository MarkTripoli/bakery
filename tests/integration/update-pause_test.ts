import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { applyRestoreFence } from "../../apps/server/src/modules/backups/restore-fence.ts";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { assertNotQuiesced } from "../../apps/server/src/platform/maintenance.ts";
import {
  pauseForUpdate,
  readUnsureActions,
  readUpdateCounts,
  resumeAfterUpdate,
  type Transact,
  UPDATE_PAUSE_OPERATION,
  UPDATE_RESUME_OPERATION,
  UpdatePauseRefusal,
} from "../../apps/server/src/platform/update-pause.ts";
import {
  removeSeededEffects,
  seedEffect,
} from "../helpers/external-effects-seed.ts";
import {
  clearInstallationMaintenance,
  holdInstallation,
} from "../helpers/installation-maintenance.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";

/**
 * #59 (server asks 1, 4 and 10) against real Postgres: the launcher pauses the
 * installation through the maintenance switch before it switches versions,
 * says what waited, refuses while a restore or a backup holds Bakery, and lets
 * go afterwards. Nothing here goes through Bakery's API: the launcher cannot
 * rely on it.
 */

const transact = (database: PgDatabase): Transact => (work) =>
  withPgTransaction(database, work);

async function reset(fixture: WorkerFixture) {
  await clearInstallationMaintenance(fixture.pgDatabase);
  await removeSeededEffects(fixture.pgDatabase);
  await fixture.pgDatabase.query(`delete from bakery.installation_restores`);
  await fixture.pgDatabase.query(
    `delete from bakery.audit_events where operation like 'installation.update.%'`,
  );
}

const withFixture = <T>(work: (fixture: WorkerFixture) => Promise<T>) =>
  withWorkerFixture(async (fixture) => {
    await reset(fixture);
    try {
      return await work(fixture);
    } finally {
      await reset(fixture);
    }
  });

/** What a guarded entry point answers right now, as its code. */
async function guard(fixture: WorkerFixture): Promise<string> {
  try {
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) => assertNotQuiesced(transaction, "intake"),
    );
    return "open";
  } catch (error) {
    if (error instanceof StandardError) return String(error.code);
    throw error;
  }
}

const switchRow = (fixture: WorkerFixture) =>
  fixture.pgDatabase.query<{ state: string; reason: string }>(
    "select state, reason from bakery.installation_maintenance where id = true",
  ).then((result) => result.rows[0]);

const audited = async (fixture: WorkerFixture, operation: string) =>
  (await fixture.pgDatabase.query<{ details: Record<string, unknown> }>(
    "select details from bakery.audit_events where operation = $1",
    [operation],
  )).rows;

Deno.test("a pause closes the guarded doors until it is resumed, and says what waited", () =>
  withFixture(async (fixture) => {
    const effect = await seedEffect(
      fixture.pgDatabase,
      fixture.organizationId,
      "uncertain",
      "github.issue.create",
    );
    assert(effect.length > 0);
    assertEquals(await guard(fixture), "open");

    const paused = await pauseForUpdate(transact(fixture.pgDatabase));
    assertEquals(paused.state, "quiesced");
    assert(paused.carriedOver.outsideActionsUnsure >= 1);
    for (
      const count of [
        paused.carriedOver.tasks,
        paused.carriedOver.approvals,
        paused.carriedOver.questions,
      ]
    ) assert(Number.isInteger(count) && count >= 0);
    assertEquals(await switchRow(fixture), {
      state: "quiesced",
      reason: "update",
    });
    // New work waits, retryably, instead of being refused for good.
    assertEquals(await guard(fixture), "INSTALLATION_QUIESCED");

    const resumed = await resumeAfterUpdate(transact(fixture.pgDatabase));
    assertEquals(resumed.released, true);
    assertEquals(await guard(fixture), "open");
    assertEquals((await switchRow(fixture)).state, "off");

    // One audit row each way, with counts and no target of any effect.
    const [pause] = await audited(fixture, UPDATE_PAUSE_OPERATION);
    assertEquals(pause.details.reason, "update");
    assertEquals(
      JSON.stringify(await audited(fixture, UPDATE_RESUME_OPERATION)).includes(
        "secret-target",
      ),
      false,
    );
  }));

Deno.test("resuming twice, or with nothing paused, changes nothing and writes no second audit row", () =>
  withFixture(async (fixture) => {
    const idle = await resumeAfterUpdate(transact(fixture.pgDatabase));
    assertEquals(idle.released, false);
    await pauseForUpdate(transact(fixture.pgDatabase));
    assertEquals(
      (await resumeAfterUpdate(transact(fixture.pgDatabase))).released,
      true,
    );
    assertEquals(
      (await resumeAfterUpdate(transact(fixture.pgDatabase))).released,
      false,
    );
    assertEquals((await audited(fixture, UPDATE_RESUME_OPERATION)).length, 1);
  }));

Deno.test("a restore hold refuses the pause before the switch is touched", () =>
  withFixture(async (fixture) => {
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        applyRestoreFence(transaction, {
          backupName: "20261121T030000Z-update-test",
          cutoffAt: null,
        }),
    );
    const refusal = await assertRejects(
      () => pauseForUpdate(transact(fixture.pgDatabase)),
      UpdatePauseRefusal,
    );
    assertEquals(refusal.code, "INSTALLATION_RESTORING");
    assertEquals(await switchRow(fixture), undefined, "no switch was written");
  }));

Deno.test("a backup holding the switch refuses the pause, and a resume leaves that backup's hold alone", () =>
  withFixture(async (fixture) => {
    await holdInstallation(fixture.pgDatabase, { state: "draining" });
    const refusal = await assertRejects(
      () => pauseForUpdate(transact(fixture.pgDatabase)),
      UpdatePauseRefusal,
    );
    assertEquals(refusal.code, "MAINTENANCE_HELD");
    assertEquals(
      (await resumeAfterUpdate(transact(fixture.pgDatabase))).released,
      false,
    );
    assertEquals(await switchRow(fixture), {
      state: "draining",
      reason: "backup",
    });
  }));

Deno.test("work that does not go quiet in time gives the installation back and refuses with a timeout", () =>
  withFixture(async (fixture) => {
    // A zero wait: the settle window has not passed on the first look.
    const refusal = await assertRejects(
      () =>
        pauseForUpdate(transact(fixture.pgDatabase), {
          timeoutSeconds: 0,
          sleep: () => Promise.resolve(),
        }),
      UpdatePauseRefusal,
    );
    assertEquals(refusal.code, "DRAIN_TIMEOUT");
    assertEquals((await switchRow(fixture)).state, "off");
    assertEquals(await guard(fixture), "open");
  }));

Deno.test("a pause whose lease lapsed leaves nothing stuck, and a second pause takes it again", () =>
  withFixture(async (fixture) => {
    await pauseForUpdate(transact(fixture.pgDatabase));
    await fixture.pgDatabase.query(
      `update bakery.installation_maintenance
          set lease_expires_at = clock_timestamp() - interval '1 second'`,
    );
    assertEquals(await guard(fixture), "open", "the lapse is the way out");
    const again = await pauseForUpdate(transact(fixture.pgDatabase));
    assertEquals(again.state, "quiesced");
  }));

Deno.test("the counts and the unsure list name kinds and counts only, never a target", () =>
  withFixture(async (fixture) => {
    await seedEffect(
      fixture.pgDatabase,
      fixture.organizationId,
      "uncertain",
      "github.issue.create",
    );
    await seedEffect(
      fixture.pgDatabase,
      fixture.organizationId,
      "uncertain",
      "github.issue.create",
    );
    await seedEffect(
      fixture.pgDatabase,
      fixture.organizationId,
      "confirmed",
      "github.issue.comment.create",
    );
    const counts = await readUpdateCounts(transact(fixture.pgDatabase));
    assert(counts.outsideActionsUnsure >= 2);
    const unsure = await readUnsureActions(transact(fixture.pgDatabase));
    const create = unsure.find((a) => a.operation === "github.issue.create");
    assert(create !== undefined && create.count >= 2);
    assertEquals(
      unsure.some((a) => a.operation === "github.issue.comment.create"),
      false,
      "a confirmed action is not unsure",
    );
    assertEquals(JSON.stringify(unsure).includes("secret-target"), false);
    assert(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(create.since),
      create.since,
    );
  }));
