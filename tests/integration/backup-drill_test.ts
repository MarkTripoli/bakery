import { assert, assertEquals } from "@std/assert";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";
import { DRILL_CHECKS } from "../../apps/server/src/modules/backups/drill-rules.ts";

/**
 * #64 slice D (also #49) against real Postgres: the runner reports a restore
 * drill, the server keeps it once as history, refuses a report that
 * contradicts itself, and shows the history to the installation administrator.
 */

const DRILL = "/v1/backup-runner/drills";
const LIST = "/v1/installation/backups/drills";

type DrillBody = {
  id: string;
  backupName: string;
  startedAt: string;
  recordedAt: string;
  outcome: string;
  failureCode: string | null;
  detail: string | null;
  cutoffAt: string | null;
  rpoSeconds: number | null;
  rtoSeconds: number;
  checksPassed: string[];
  checksFailed: string[];
};

const query = (o: BackupSettingsFixture) => o.f.pgDatabase;

async function cleanup(o: BackupSettingsFixture) {
  await query(o).query(`delete from bakery.backup_drills`);
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

/** A coherent passing report: every check passed, with a cutoff and its age. */
const passing = (overrides: Record<string, unknown> = {}) => ({
  drillId: crypto.randomUUID(),
  backupName: "20261121T030000Z-0b6c1f7e",
  startedAt: "2026-11-21T04:00:00.000Z",
  outcome: "passed",
  cutoffAt: "2026-11-21T03:00:05.000Z",
  rpoSeconds: 3595,
  rtoSeconds: 142,
  checksPassed: [...DRILL_CHECKS],
  checksFailed: [],
  ...overrides,
});

/** A coherent failing report: the migration check failed. */
const failing = (overrides: Record<string, unknown> = {}) => ({
  drillId: crypto.randomUUID(),
  backupName: "20261120T030000Z-5a1d9c02",
  startedAt: "2026-11-21T04:10:00.000Z",
  outcome: "failed",
  failureCode: "migration_unsupported",
  detail:
    "The backup holds migration 0310 and this release knows up to 0299; install a release at least as new as the backup, then run the drill again.",
  cutoffAt: null,
  rpoSeconds: null,
  rtoSeconds: 61,
  checksPassed: ["manifest", "checksums", "key", "postgres"],
  checksFailed: ["migrations"],
  ...overrides,
});

const report = (
  o: BackupSettingsFixture,
  credential: string,
  body: Record<string, unknown>,
) => o.runner(credential, "POST", DRILL, body);

const stored = async (o: BackupSettingsFixture) =>
  Number(
    (await query(o).query<{ n: string }>(
      `select count(*)::text as n from bakery.backup_drills`,
    )).rows[0].n,
  );

Deno.test("a reported drill is kept once, and reporting it again returns the same record", () =>
  withFixture(async (o) => {
    const credential = await o.issueCredential();
    const body = passing();
    const first = await report(o, credential, body);
    assertEquals(first.status, 200, await first.clone().text());
    const kept = await first.json() as DrillBody;
    assertEquals(kept.id, body.drillId);
    assertEquals(kept.outcome, "passed");
    assertEquals(kept.rpoSeconds, 3595);
    assertEquals(kept.rtoSeconds, 142);
    assertEquals(kept.checksPassed, [...DRILL_CHECKS]);
    assertEquals(kept.failureCode, null);

    const again = await report(o, credential, body);
    assertEquals(again.status, 200, await again.clone().text());
    const same = await again.json() as DrillBody;
    // The same record, not a second one: recordedAt did not move.
    assertEquals(same, kept);
    assertEquals(await stored(o), 1);
  }));

Deno.test("the same drill id with different content is refused and changes nothing", () =>
  withFixture(async (o) => {
    const credential = await o.issueCredential();
    const body = passing();
    assertEquals((await report(o, credential, body)).status, 200);
    const reused = await report(
      o,
      credential,
      { ...body, rtoSeconds: 999 },
    );
    assertEquals(reused.status, 409, await reused.clone().text());
    const problem = await reused.json() as { code: string };
    assertEquals(problem.code, "STATE_CONFLICT");
    const row = (await query(o).query<{ rto: number }>(
      `select rto_seconds as rto from bakery.backup_drills where id = $1`,
      [body.drillId],
    )).rows[0];
    assertEquals(row.rto, 142);
    assertEquals(await stored(o), 1);
  }));

Deno.test("a report that contradicts itself is refused with 422 and stores nothing", () =>
  withFixture(async (o) => {
    const credential = await o.issueCredential();
    const cases: [string, Record<string, unknown>][] = [
      [
        "a pass with a failure code",
        passing({ failureCode: "restore_failed" }),
      ],
      ["a pass with a detail", passing({ detail: "all good" })],
      ["a pass with a failed check", passing({ checksFailed: ["redis"] })],
      [
        "a pass that skipped a check",
        passing({
          checksPassed: DRILL_CHECKS.filter((name) => name !== "references"),
        }),
      ],
      ["a failure with no code", failing({ failureCode: null })],
      ["a failure with no detail", failing({ detail: null })],
      ["a failure with no failed check", failing({ checksFailed: [] })],
      [
        "an unknown check",
        passing({ checksPassed: [...DRILL_CHECKS, "bogus"] }),
      ],
      [
        "a check in both lists",
        failing({ checksPassed: ["manifest", "migrations"] }),
      ],
      ["an age with no cutoff", passing({ cutoffAt: null })],
      ["a cutoff with no age", passing({ rpoSeconds: null })],
    ];
    for (const [name, body] of cases) {
      const response = await report(o, credential, body);
      assertEquals(response.status, 422, `${name}: ${await response.text()}`);
    }
    assertEquals(await stored(o), 0);
  }));

Deno.test("only the runner credential may report, and the report is checked before it is read", () =>
  withFixture(async (o) => {
    const credential = await o.issueCredential();
    const wrong = await o.runner(
      credential.slice(0, -1) + (credential.endsWith("a") ? "b" : "a"),
      "POST",
      DRILL,
      passing(),
    );
    assert(wrong.status === 401 || wrong.status === 403, `${wrong.status}`);
    await wrong.body?.cancel();
    const none = await o.f.app.request(DRILL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passing()),
    });
    assert(none.status === 401 || none.status === 403, `${none.status}`);
    await none.body?.cancel();
    assertEquals(await stored(o), 0);
  }));

Deno.test("the administrator sees the history newest first, in pages", () =>
  withFixture(async (o) => {
    const credential = await o.issueCredential();
    const ids: string[] = [];
    for (const body of [passing(), failing(), passing()]) {
      const response = await report(o, credential, body);
      assertEquals(response.status, 200, await response.clone().text());
      await response.body?.cancel();
      ids.push(body.drillId);
    }
    const pageOne = await o.admin("GET", `${LIST}?limit=2`);
    assertEquals(pageOne.status, 200, await pageOne.clone().text());
    const first = await pageOne.json() as {
      items: DrillBody[];
      nextCursor: string | null;
    };
    assertEquals(first.items.map((item) => item.id), [ids[2], ids[1]]);
    assert(first.nextCursor !== null);
    const pageTwo = await o.admin(
      "GET",
      `${LIST}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    assertEquals(pageTwo.status, 200, await pageTwo.clone().text());
    const second = await pageTwo.json() as {
      items: DrillBody[];
      nextCursor: string | null;
    };
    assertEquals(second.items.map((item) => item.id), [ids[0]]);
    assertEquals(second.nextCursor, null);
    const failed = first.items[1];
    assertEquals(failed.outcome, "failed");
    assertEquals(failed.failureCode, "migration_unsupported");
    assertEquals(failed.rpoSeconds, null);
    assertEquals(failed.checksFailed, ["migrations"]);
  }));

Deno.test("recording a drill audits names and numbers only", () =>
  withFixture(async (o) => {
    const credential = await o.issueCredential();
    const body = passing();
    assertEquals((await report(o, credential, body)).status, 200);
    const rows = (await query(o).query<{ details: unknown }>(
      `select details from bakery.audit_events
        where operation = 'backupRunner.drill'
        order by created_at desc limit 1`,
    )).rows;
    assertEquals(rows.length, 1);
    const text = JSON.stringify(rows[0].details);
    assert(text.includes(body.drillId));
    assert(!text.includes(credential), "the credential is never audited");
    assert(!text.includes(body.backupName), "no set name beyond the id");
  }));

Deno.test("only an installation administrator may list drills: a developer and an anonymous caller are refused and learn nothing", () =>
  withFixture(async (o) => {
    const credential = await o.issueCredential();
    const body = passing();
    const seeded = await report(o, credential, body);
    assertEquals(seeded.status, 200, await seeded.clone().text());
    await seeded.body?.cancel();

    // The administrator sees it.
    const admin = await o.admin("GET", LIST);
    assertEquals(admin.status, 200);
    assertEquals(
      ((await admin.json()) as { items: unknown[] }).items.length,
      1,
    );

    // A developer is authenticated but is not an installation administrator.
    const developer = await o.admin("GET", LIST, undefined, {
      cookie: o.f.developerCookie,
    });
    assertEquals(developer.status, 403, await developer.clone().text());
    const refusal = await developer.text();
    assert(refusal.includes("AUTH_FORBIDDEN"), refusal);
    assert(
      !refusal.includes(body.backupName) && !refusal.includes(body.drillId),
      "a refusal leaks no drill data",
    );

    // An anonymous caller is refused before anything is read.
    const anonymous = await o.f.app.request(LIST, { method: "GET" });
    assert([401, 403].includes(anonymous.status), String(anonymous.status));
    const anonymousBody = await anonymous.text();
    assert(!anonymousBody.includes(body.backupName), anonymousBody);
  }));
