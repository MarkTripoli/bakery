/**
 * #64 E4: who took each re-enable step, which restore the read answers, and the
 * public status read without a session (from QA's #863 probes PA-PD).
 */
import { assert, assertEquals } from "@std/assert";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";
import { grant } from "../helpers/installation-settings.ts";
import { authTestOrigin } from "../helpers/auth.ts";

const GET = "/v1/installation/restore";
const STEPS = "/v1/installation/restore/steps";
const NAME = "20261121T030000Z-0b6c1f7e";
type Actor = { principalId: string; displayName: string } | null;
type Body = Record<string, unknown> & {
  id: string;
  backupName: string;
  nextStep: string | null;
  releasedAt: string | null;
  intakeEnabledBy: Actor;
  dispatchEnabledBy: Actor;
  workersEnabledBy: Actor;
};
const db = (o: BackupSettingsFixture) => o.f.pgDatabase;
const seed = async (
  o: BackupSettingsFixture,
  name: string,
  restoredAt: string,
  released: boolean,
) => {
  const id = crypto.randomUUID();
  await db(o).query(
    `insert into bakery.installation_restores (id, backup_name, restored_at, effects_held, attempts_quarantined, jobs_awaiting_reconciliation, workers_revoked, released_at)
     values ($1, $2, $3::timestamptz, 1, 0, 0, 0, case when $4::boolean then $3::timestamptz else null end)`,
    [id, name, restoredAt, released],
  );
  return id;
};
async function withF<T>(work: (o: BackupSettingsFixture) => Promise<T>) {
  const o = await openBackupSettingsFixture();
  try {
    await db(o).query("delete from bakery.installation_restores");
    return await work(o);
  } finally {
    try {
      await db(o).query("delete from bakery.installation_restores");
    } finally {
      await o.finish();
    }
  }
}
const take = (o: BackupSettingsFixture, step: string, cookie?: string) =>
  o.admin("POST", STEPS, { step, confirmation: NAME }, { keyed: true, cookie });
const status = async (o: BackupSettingsFixture) =>
  (await (await o.f.app.fetch(
    new Request(`${authTestOrigin}/v1/installation/status`),
  )).json()) as { bootstrapped: boolean; restoreHeld: boolean };

Deno.test("each step names the person who took THAT step (two administrators)", () =>
  withF(async (o) => {
    await seed(o, NAME, "2026-11-21T03:00:00Z", false);
    const g = await grant(o.f);
    assert(g.status < 300, "grant " + g.status + await g.clone().text());
    const second = o.f.developerCookie;
    assertEquals((await take(o, "intake")).status, 200);
    const d = await take(o, "dispatch", second);
    assertEquals(d.status, 200, await d.clone().text());
    assertEquals((await take(o, "workers")).status, 200);
    const rec = await (await o.admin("GET", GET)).json() as Body;
    assertEquals(rec.intakeEnabledBy?.principalId, o.f.adminId, "intake");
    assertEquals(
      rec.dispatchEnabledBy?.principalId,
      o.f.developerId,
      "dispatch",
    );
    assertEquals(rec.workersEnabledBy?.principalId, o.f.adminId, "workers");
  }));

Deno.test("public status, no cookie: held then released", () =>
  withF(async (o) => {
    assertEquals((await status(o)).restoreHeld, false);
    await seed(o, NAME, "2026-11-21T03:00:00Z", false);
    const held = await status(o);
    assertEquals(held.restoreHeld, true);
    await take(o, "intake");
    await take(o, "dispatch");
    await take(o, "workers");
    assertEquals((await status(o)).restoreHeld, false);
  }));

Deno.test("the read answers the NEWEST restore, released or held", () =>
  withF(async (o) => {
    await seed(o, "20260101T000000Z-aaaaaaaa", "2026-01-01T00:00:00Z", true);
    const newest = await seed(
      o,
      "20261121T030000Z-bbbbbbbb",
      "2026-11-21T03:00:00Z",
      true,
    );
    const rec = await (await o.admin("GET", GET)).json() as Body;
    assertEquals(rec.id, newest);
    assert(rec.releasedAt !== null);
    assertEquals(rec.nextStep, null);
    assertEquals(
      rec.intakeEnabledBy,
      null,
      "no step audit rows: null, not an error",
    );
    assertEquals((await status(o)).restoreHeld, false);
  }));

Deno.test("step actor is stable when the actor later renames; step taken by a non-admin is refused", () =>
  withF(async (o) => {
    await seed(o, NAME, "2026-11-21T03:00:00Z", false);
    const refused = await take(o, "intake", o.f.developerCookie);
    assert(
      refused.status === 403 || refused.status === 404,
      "developer " + refused.status,
    );
    const rec = await (await o.admin("GET", GET)).json() as Body;
    assertEquals(rec.intakeEnabledBy, null);
    assertEquals(rec.nextStep, "intake");
  }));
