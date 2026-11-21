import { assert, assertEquals } from "@std/assert";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
  runnerSettingsPath,
} from "../helpers/backup-settings.ts";

/**
 * #80 point-in-time P1 against Postgres and the real routes: the "Restore to
 * any minute" switch, the runner's report of the window it holds off-site,
 * and the window the administrator reads.
 */

const PATH = "/v1/installation/backup-point-in-time";
const WAL = "/v1/backup-runner/wal";
type Json = Record<string, unknown>;

async function withFixture(work: (o: BackupSettingsFixture) => Promise<void>) {
  const o = await openBackupSettingsFixture();
  try {
    await work(o);
  } finally {
    await o.finish();
  }
}

async function json(response: Response, status = 200): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

const put = (o: BackupSettingsFixture, enabled: boolean, version?: number) =>
  o.admin("PUT", PATH, { enabled }, { keyed: true, version });

const row = async (o: BackupSettingsFixture) =>
  (await o.f.pgDatabase.query(
    "select enabled, version, earliest_restorable_at, latest_restorable_at, latest_segment, reported_at from bakery.backup_point_in_time_settings",
  )).rows as Json[];

const report = {
  latestArchivedAt: "2026-11-21T09:59:00.000Z",
  earliestBaseBackupAt: "2026-11-20T03:00:00.000Z",
  latestSegment: "000000010000000000000042",
};

Deno.test("the switch reads off, turns on with If-Match rules, and the runner sees it", async () => {
  await withFixture(async (o) => {
    const first = await json(await o.admin("GET", PATH));
    assertEquals([first.enabled, first.version], [false, 0]);
    const on = await json(await put(o, true));
    assertEquals([on.enabled, on.version], [true, 1]);
    assertEquals((await put(o, false)).status, 428);
    assertEquals((await put(o, false, 7)).status, 412);
    const credential = await o.issueCredential();
    const settings = await json(
      await o.runner(credential, "GET", runnerSettingsPath),
    );
    assertEquals(settings.pointInTimeEnabled, true);
  });
});

Deno.test("the runner's report sets the window; a late report never shrinks it; off forgets it", async () => {
  await withFixture(async (o) => {
    const credential = await o.issueCredential();
    // Off: the report is ignored.
    await json(await o.runner(credential, "POST", WAL, report));
    assertEquals(
      (await json(await o.admin("GET", PATH))).latestRestorableAt,
      null,
    );

    await json(await put(o, true));
    const reported = await json(
      await o.runner(credential, "POST", WAL, report),
    );
    assertEquals(reported.earliestRestorableAt, report.earliestBaseBackupAt);
    assertEquals(reported.latestRestorableAt, report.latestArchivedAt);

    const late = await json(
      await o.runner(credential, "POST", WAL, {
        ...report,
        latestArchivedAt: "2026-11-21T09:00:00.000Z",
        latestSegment: "000000010000000000000040",
      }),
    );
    assertEquals(late.latestRestorableAt, report.latestArchivedAt);

    const off = await json(await put(o, false, 1));
    assertEquals([off.enabled, off.latestRestorableAt], [false, null]);
    const on = await json(await put(o, true, 2));
    assertEquals(on.latestRestorableAt, null);
  });
});

Deno.test("a bad report is refused and only the runner credential may report", async () => {
  await withFixture(async (o) => {
    const credential = await o.issueCredential();
    await json(await put(o, true));
    for (
      const bad of [
        { ...report, latestSegment: "../etc/passwd" },
        { ...report, earliestBaseBackupAt: "2026-11-22T00:00:00.000Z" },
        { ...report, latestArchivedAt: "2099-01-01T00:00:00.000Z" },
      ]
    ) {
      const refused = await o.runner(credential, "POST", WAL, bad);
      assertEquals(refused.status, 422, JSON.stringify(bad));
      await refused.body?.cancel();
    }
    const browser = await o.admin("POST", WAL, report);
    assert(
      browser.status === 401 || browser.status === 403,
      String(browser.status),
    );
    await browser.body?.cancel();
    const stranger = await o.runner(
      "bkr_" + "x".repeat(40),
      "POST",
      WAL,
      report,
    );
    assert(
      stranger.status === 401 || stranger.status === 403,
      String(stranger.status),
    );
    await stranger.body?.cancel();
    assertEquals(
      (await json(await o.admin("GET", PATH))).latestRestorableAt,
      null,
    );
  });
});

Deno.test("a member who is not an installation administrator cannot read or set it", async () => {
  await withFixture(async (o) => {
    const cookie = o.f.developerCookie;
    assert(
      [403, 404].includes(
        (await o.admin("GET", PATH, undefined, { cookie })).status,
      ),
    );
    assert(
      [403, 404].includes(
        (await o.admin("PUT", PATH, { enabled: true }, { keyed: true, cookie }))
          .status,
      ),
    );
  });
});

Deno.test("the stored window: a report while off leaves no trace, a stale one moves nothing, off clears the columns", async () => {
  await withFixture(async (o) => {
    const credential = await o.issueCredential();
    // Saved off: a report must be ignored, also after turning on again.
    await json(await put(o, false));
    await json(await o.runner(credential, "POST", WAL, report));
    let r = (await row(o))[0] as Json;
    assertEquals([
      r.latest_restorable_at,
      r.earliest_restorable_at,
      r.reported_at,
    ], [null, null, null]);
    const on = await json(await put(o, true, 1));
    assertEquals([on.earliestRestorableAt, on.latestRestorableAt], [
      null,
      null,
    ]);
    // On: window, then a stale report: the newest bound and segment stay.
    await json(await o.runner(credential, "POST", WAL, report));
    await json(
      await o.runner(credential, "POST", WAL, {
        ...report,
        latestArchivedAt: "2026-11-21T08:00:00.000Z",
        latestSegment: "000000010000000000000010",
      }),
    );
    r = (await row(o))[0] as Json;
    assertEquals(r.latest_segment, "000000010000000000000042");
    assertEquals(
      new Date(r.latest_restorable_at as string).toISOString(),
      report.latestArchivedAt,
    );
    // A newer report moves both.
    const newer = await json(
      await o.runner(credential, "POST", WAL, {
        ...report,
        latestArchivedAt: "2026-11-21T10:30:00.000Z",
        latestSegment: "000000010000000000000050",
      }),
    );
    assertEquals(newer.latestRestorableAt, "2026-11-21T10:30:00.000Z");
    r = (await row(o))[0] as Json;
    assertEquals(r.latest_segment, "000000010000000000000050");
    // Off clears the stored columns, not only the projection.
    await json(await put(o, false, 2));
    r = (await row(o))[0] as Json;
    assertEquals([
      r.earliest_restorable_at,
      r.latest_restorable_at,
      r.latest_segment,
    ], [null, null, null]);
    const settings = await json(
      await o.runner(credential, "GET", runnerSettingsPath),
    );
    assertEquals(settings.pointInTimeEnabled, false);
  });
});

Deno.test("a late report cannot move the earliest bound back to a pruned base backup", async () => {
  await withFixture(async (o) => {
    const credential = await o.issueCredential();
    await json(await put(o, true));
    // B: newer, and its oldest base backup is T2 (T1 was pruned).
    await json(
      await o.runner(credential, "POST", WAL, {
        latestArchivedAt: "2026-11-21T10:00:00.000Z",
        earliestBaseBackupAt: "2026-11-21T03:00:00.000Z",
        latestSegment: "000000010000000000000050",
      }),
    );
    // A: delayed, older, still naming T1.
    const late = await json(
      await o.runner(credential, "POST", WAL, {
        latestArchivedAt: "2026-11-21T09:00:00.000Z",
        earliestBaseBackupAt: "2026-11-20T03:00:00.000Z",
        latestSegment: "000000010000000000000048",
      }),
    );
    assertEquals(late.earliestRestorableAt, "2026-11-21T03:00:00.000Z");
    assertEquals(late.latestRestorableAt, "2026-11-21T10:00:00.000Z");
  });
});
