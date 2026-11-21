import { assert, assertEquals } from "@std/assert";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  assertNotQuiesced,
  type RestoreDoor,
} from "../../apps/server/src/platform/maintenance.ts";

/**
 * #64 slice E3 against real Postgres: the ordered re-enable of a restored
 * installation. One unreleased restore record holds every door; an installation
 * administrator opens intake, then dispatch, then workers, each with the
 * restored backup's name typed as the confirmation, and every refusal is named
 * and changes nothing.
 */

const GET = "/v1/installation/restore";
const STEPS = "/v1/installation/restore/steps";
const NAME = "20261121T030000Z-0b6c1f7e";

type RestoreBody = {
  id: string;
  backupName: string;
  intakeEnabledAt: string | null;
  dispatchEnabledAt: string | null;
  workersEnabledAt: string | null;
  releasedAt: string | null;
  nextStep: string | null;
  effectsHeld: number;
};

const database = (o: BackupSettingsFixture) => o.f.pgDatabase;

async function cleanup(o: BackupSettingsFixture) {
  await database(o).query(`delete from bakery.installation_restores`);
}

async function withFixture<T>(work: (o: BackupSettingsFixture) => Promise<T>) {
  const o = await openBackupSettingsFixture();
  try {
    await cleanup(o);
    return await work(o);
  } finally {
    try {
      await cleanup(o);
    } finally {
      await o.finish();
    }
  }
}

/** What the fence leaves behind: one unreleased record, with counts. */
async function seedRestore(o: BackupSettingsFixture): Promise<string> {
  const id = crypto.randomUUID();
  await database(o).query(
    `insert into bakery.installation_restores
       (id, backup_name, effects_held, attempts_quarantined,
        jobs_awaiting_reconciliation, workers_revoked)
     values ($1, $2, 3, 2, 2, 1)`,
    [id, NAME],
  );
  return id;
}

const take = (o: BackupSettingsFixture, step: string, confirmation = NAME) =>
  o.admin("POST", STEPS, { step, confirmation }, { keyed: true });

async function refusal(response: Response) {
  const text = await response.text();
  return { status: response.status, text };
}

/** The code a door answers with, or null when it is open. */
async function doorAnswer(
  o: BackupSettingsFixture,
  door: RestoreDoor,
): Promise<string | null> {
  try {
    await withPgTransaction(
      database(o),
      (transaction) => assertNotQuiesced(transaction, door),
    );
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

const doors = async (o: BackupSettingsFixture) => [
  await doorAnswer(o, "intake"),
  await doorAnswer(o, "dispatch"),
  await doorAnswer(o, "workers"),
];

Deno.test("with no restore held there is nothing to read or re-enable", () =>
  withFixture(async (o) => {
    const read = await refusal(await o.admin("GET", GET));
    assertEquals(read.status, 409, read.text);
    assert(read.text.includes("RESTORE_NOT_HELD"), read.text);
    const step = await refusal(await take(o, "intake"));
    assertEquals(step.status, 409);
    assert(step.text.includes("RESTORE_NOT_HELD"), step.text);
    assertEquals(await doors(o), [null, null, null]);
  }));

Deno.test("the steps open the doors in order, and the last one releases the restore", () =>
  withFixture(async (o) => {
    await seedRestore(o);
    const closed = "INSTALLATION_RESTORING";
    assertEquals(await doors(o), [closed, closed, closed]);

    const held = await (await o.admin("GET", GET)).json() as RestoreBody;
    assertEquals(held.backupName, NAME);
    assertEquals(held.nextStep, "intake");
    assertEquals(held.effectsHeld, 3);
    assertEquals(held.releasedAt, null);

    const intake = await take(o, "intake");
    assertEquals(intake.status, 200, await intake.clone().text());
    const afterIntake = await intake.json() as RestoreBody;
    assert(afterIntake.intakeEnabledAt !== null);
    assertEquals(afterIntake.nextStep, "dispatch");
    assertEquals(await doors(o), [null, closed, closed]);

    const dispatch = await take(o, "dispatch");
    assertEquals(dispatch.status, 200, await dispatch.clone().text());
    assertEquals(
      ((await dispatch.json()) as RestoreBody).nextStep,
      "workers",
    );
    assertEquals(await doors(o), [null, null, closed]);

    const workers = await take(o, "workers");
    assertEquals(workers.status, 200, await workers.clone().text());
    const done = await workers.json() as RestoreBody;
    assert(done.workersEnabledAt !== null && done.releasedAt !== null);
    assertEquals(done.nextStep, null);
    assertEquals(await doors(o), [null, null, null]);

    // Released: nothing is held, so there is nothing left to take or read.
    assertEquals((await refusal(await o.admin("GET", GET))).status, 409);
    const again = await refusal(await take(o, "workers"));
    assertEquals(again.status, 409);
    assert(again.text.includes("RESTORE_NOT_HELD"), again.text);
  }));

Deno.test("each refusal is named and changes nothing", () =>
  withFixture(async (o) => {
    await seedRestore(o);
    const state = async () =>
      JSON.stringify(
        (await database(o).query(
          `select intake_enabled_at, dispatch_enabled_at, workers_enabled_at,
                  released_at from bakery.installation_restores`,
        )).rows,
      );
    const before = await state();

    // A mistyped confirmation, in any case or with spaces, is refused.
    for (const typed of ["", "yes", NAME.toLowerCase().slice(1), ` ${NAME}`]) {
      const wrong = await refusal(await take(o, "intake", typed));
      assert([400, 422].includes(wrong.status), String(wrong.status));
      assert(
        wrong.text.includes("RESTORE_CONFIRMATION_MISMATCH") ||
          wrong.text.includes("MALFORMED_REQUEST"),
        wrong.text,
      );
    }
    const mismatch = await refusal(await take(o, "intake", "other-backup"));
    assertEquals(mismatch.status, 422);
    assert(mismatch.text.includes("RESTORE_CONFIRMATION_MISMATCH"));

    // A later step first.
    for (const step of ["dispatch", "workers"]) {
      const early = await refusal(await take(o, step));
      assertEquals(early.status, 409);
      assert(early.text.includes("RESTORE_STEP_OUT_OF_ORDER"), early.text);
      assert(early.text.includes("intake"), "it names the step to take");
    }
    // The confirmation is checked before the order.
    const both = await refusal(await take(o, "workers", "nope"));
    assert(both.text.includes("RESTORE_CONFIRMATION_MISMATCH"), both.text);
    assertEquals(await state(), before);

    // A step already taken.
    assertEquals((await take(o, "intake")).status, 200);
    const taken = await refusal(await take(o, "intake"));
    assertEquals(taken.status, 409);
    assert(taken.text.includes("RESTORE_STEP_ALREADY_TAKEN"), taken.text);
    // An unknown step is a malformed request, not a step.
    const unknown = await refusal(await take(o, "everything"));
    assertEquals(unknown.status, 400);
  }));

Deno.test("only an installation administrator with a session may take a step, and a refusal learns nothing", () =>
  withFixture(async (o) => {
    await seedRestore(o);
    const developer = await o.admin(
      "POST",
      STEPS,
      { step: "intake", confirmation: NAME },
      { keyed: true, cookie: o.f.developerCookie },
    );
    assertEquals(developer.status, 403, await developer.clone().text());
    const text = await developer.text();
    assert(text.includes("AUTH_FORBIDDEN"), text);
    assert(!text.includes(NAME), "a refusal does not show the backup's name");

    const read = await o.admin("GET", GET, undefined, {
      cookie: o.f.developerCookie,
    });
    assertEquals(read.status, 403);
    assert(!(await read.text()).includes(NAME));

    const anonymous = await o.f.app.request(STEPS, {
      method: "POST",
      body: JSON.stringify({ step: "intake", confirmation: NAME }),
    });
    assert([401, 403].includes(anonymous.status), String(anonymous.status));

    // A runner credential is not an administrator's session.
    const credential = await o.issueCredential();
    const runner = await o.runner(credential, "POST", STEPS, {
      step: "intake",
      confirmation: NAME,
    });
    assert([401, 403, 404].includes(runner.status), String(runner.status));
    await runner.body?.cancel();

    assertEquals(
      (await database(o).query(
        `select count(*)::int as n from bakery.installation_restores
          where intake_enabled_at is not null`,
      )).rows[0].n,
      0,
    );
  }));

Deno.test("a step is audited by name and step", () =>
  withFixture(async (o) => {
    const id = await seedRestore(o);
    assertEquals((await take(o, "intake")).status, 200);
    const rows = (await database(o).query<{ details: unknown }>(
      `select details from bakery.audit_events
        where operation = 'installationRestore.step' and resource_id = $1`,
      [id],
    )).rows;
    assertEquals(rows.length, 1);
    const details = JSON.stringify(rows[0].details);
    assert(details.includes("intake") && details.includes(NAME), details);
  }));

Deno.test("a step without an Idempotency-Key is refused and opens nothing", () =>
  withFixture(async (o) => {
    await seedRestore(o);
    const keyless = await refusal(
      await o.admin("POST", STEPS, { step: "intake", confirmation: NAME }),
    );
    assertEquals(keyless.status, 428, keyless.text);
    assertEquals(await doors(o), [
      "INSTALLATION_RESTORING",
      "INSTALLATION_RESTORING",
      "INSTALLATION_RESTORING",
    ]);
  }));
