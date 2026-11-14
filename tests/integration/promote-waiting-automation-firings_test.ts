import { assert, assertEquals } from "@std/assert";
import { admitDueAutomations } from "../../apps/server/src/modules/workflows/automations/tick.ts";
import { promoteWaitingFirings } from "../../apps/server/src/modules/workflows/automations/promote.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { setUpAutomation } from "../helpers/automation-fixtures.ts";
import { apiCall, expectJson } from "../helpers/fixed-coding-preset.ts";

// #36 slice 4c. The clock admits an occurrence that comes due while the
// automation is busy as a skipped firing (`skip`) or as the one waiting firing
// (`queue_one`); the promotion pass starts a waiting firing, oldest first, once
// no run of the automation is active, and starts at most one run however many
// passes run at once.

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

async function setUp(fixture: Fixture, overlapPolicy: "skip" | "queue_one") {
  const s = await setUpAutomation(fixture);
  const version = overlapPolicy === "skip"
    ? s.version
    : await expectJson<{ id: string }>(
      await s.createVersion({ overlapPolicy }),
      201,
    );
  const read = async () =>
    await expectJson<{ version: number }>(
      await apiCall(
        fixture,
        s.scope,
        "GET",
        `/v1/automations/${s.automation.id}`,
      ),
      200,
    );
  await expectJson(
    await apiCall(
      fixture,
      s.scope,
      "PATCH",
      `/v1/automations/${s.automation.id}`,
      {
        body: { activeVersionId: version.id },
        headers: { "If-Match": `"${(await read()).version}"` },
      },
    ),
    200,
  );
  const due = (at: string) =>
    fixture.pgDatabase.query(
      `update bakery.automation_definitions set next_fire_at = $2 where id = $1`,
      [s.automation.id, at],
    );
  const tick = (now: string) =>
    admitDueAutomations({ database: fixture.pgDatabase, now: new Date(now) });
  const firings = async () =>
    (await fixture.pgDatabase.query<
      {
        at: string;
        status: string;
        pending: boolean;
        skipped: number;
        runId: string | null;
      }
    >(
      `select f.scheduled_at::text as at, f.status, f.pending,
              f.skipped_count as skipped, f.run_id as "runId"
         from bakery.automation_firings f
         join bakery.automation_versions v
           on v.organization_id = f.organization_id and v.id = f.automation_version_id
        where v.automation_id = $1 order by f.scheduled_at`,
      [s.automation.id],
    )).rows;
  const endRuns = () =>
    fixture.pgDatabase.query(
      `update bakery.workflow_runs set status = 'completed'
        where organization_id = $1`,
      [s.scope.organizationId],
    );
  const promote = () => promoteWaitingFirings({ database: fixture.pgDatabase });
  return { s, version, due, tick, firings, endRuns, promote };
}

Deno.test("a free automation: the due occurrence waits as a queued firing and the next promotion starts it, once", () =>
  withWorkerFixture(async (fixture) => {
    const t = await setUp(fixture, "skip");
    await t.due("2026-11-10T03:00:00Z");
    const ticked = await t.tick("2026-11-10T03:00:30Z");
    assertEquals([ticked.admitted, ticked.failed.length], [1, 0]);
    const [waiting] = await t.firings();
    assertEquals([waiting!.status, waiting!.pending, waiting!.runId], [
      "queued",
      true,
      null,
    ]);
    // Two promotion passes at once: one run.
    const both = await Promise.all([t.promote(), t.promote()]);
    assertEquals(both.reduce((n, r) => n + r.started, 0), 1);
    assertEquals(both.flatMap((r) => r.errors), []);
    const [started] = await t.firings();
    assertEquals([started!.status, started!.pending], ["started", false]);
    assert(started!.runId !== null);
    assertEquals((await t.s.counts()).runs, "1");
    // Nothing waits any more: a pass finds nothing.
    assertEquals(await t.promote(), {
      started: 0,
      held: 0,
      refused: 0,
      errors: [],
    });
  }));

Deno.test("skip: an occurrence that comes due while a run is active is recorded as skipped and runs nothing", () =>
  withWorkerFixture(async (fixture) => {
    const t = await setUp(fixture, "skip");
    await t.due("2026-11-10T03:00:00Z");
    await t.tick("2026-11-10T03:00:30Z");
    await t.promote();
    assertEquals((await t.s.counts()).runs, "1");
    // The run is still active when the next occurrence is due.
    await t.due("2026-11-11T03:00:00Z");
    await t.tick("2026-11-11T03:00:30Z");
    const rows = await t.firings();
    assertEquals(rows.map((r) => [r.status, r.pending, r.skipped]), [
      ["started", false, 0],
      ["skipped", false, 1],
    ]);
    assertEquals(rows[1]!.runId, null);
    assertEquals(await t.promote(), {
      started: 0,
      held: 0,
      refused: 0,
      errors: [],
    });
    assertEquals((await t.s.counts()).runs, "1");
    // Once the run has ended the next occurrence is queued and starts.
    await t.endRuns();
    await t.due("2026-11-12T03:00:00Z");
    await t.tick("2026-11-12T03:00:30Z");
    assertEquals((await t.promote()).started, 1);
    assertEquals((await t.s.counts()).runs, "2");
  }));

Deno.test("queue_one: one firing waits behind the active run, further occurrences are skipped, and it starts when the run ends", () =>
  withWorkerFixture(async (fixture) => {
    const t = await setUp(fixture, "queue_one");
    await t.due("2026-11-10T03:00:00Z");
    await t.tick("2026-11-10T03:00:30Z");
    assertEquals((await t.promote()).started, 1);
    // A run is active: the next occurrence waits, the one after is skipped.
    await t.due("2026-11-11T03:00:00Z");
    await t.tick("2026-11-11T03:00:30Z");
    await t.due("2026-11-12T03:00:00Z");
    await t.tick("2026-11-12T03:00:30Z");
    assertEquals(
      (await t.firings()).map((r) => [r.status, r.pending]),
      [["started", false], ["queued", true], ["skipped", false]],
    );
    // Held while the run is active, however often asked: it is not even a
    // candidate (so it cannot crowd out a firing that can start).
    for (let pass = 0; pass < 2; pass += 1) {
      assertEquals(await t.promote(), {
        started: 0,
        held: 0,
        refused: 0,
        errors: [],
      });
    }
    assertEquals((await t.s.counts()).runs, "1");
    // The run ends: the waiting firing starts, exactly once, under two passes.
    await t.endRuns();
    const both = await Promise.all([t.promote(), t.promote()]);
    assertEquals(both.reduce((n, r) => n + r.started, 0), 1);
    assertEquals((await t.s.counts()).runs, "2");
    assertEquals(
      (await t.firings()).map((r) => [r.status, r.pending]),
      [["started", false], ["started", false], ["skipped", false]],
    );
  }));

Deno.test("a waiting firing the workflow refuses is marked failed with its code, and the pass goes on", () =>
  withWorkerFixture(async (fixture) => {
    // A budget of 0 cannot reserve for the workflow's model step.
    const s = await setUpAutomation(fixture, { budgetLimitUsd: "0" });
    await expectJson(
      await apiCall(
        fixture,
        s.scope,
        "PATCH",
        `/v1/automations/${s.automation.id}`,
        {
          body: { activeVersionId: s.version.id },
          headers: { "If-Match": '"1"' },
        },
      ),
      200,
    );
    const id = await s.queue(s.version.id);
    const result = await promoteWaitingFirings({
      database: fixture.pgDatabase,
    });
    assertEquals(result, { started: 0, held: 0, refused: 1, errors: [] });
    const failed = await s.firing(id);
    assertEquals([failed.status, failed.pending, failed.failureCode], [
      "failed",
      false,
      "budget_below_reservation",
    ]);
    assertEquals((await s.counts()).runs, "0");
  }));

Deno.test("held firings ahead of a startable one do not fill the batch: the pass always reaches a firing it can start", () =>
  withWorkerFixture(async (fixture) => {
    const t = await setUp(fixture, "queue_one");
    // One real run, still active, which the held automations point at.
    await t.due("2026-11-01T03:00:00Z");
    await t.tick("2026-11-01T03:00:30Z");
    assertEquals((await t.promote()).started, 1);
    const runId = (await t.firings())[0]!.runId!;
    const BATCH = 3;
    const db = fixture.pgDatabase;
    const org = t.s.scope.organizationId;
    let counter = 0;
    /** An automation of its own, optionally held by that run, with one waiting firing. */
    const automation = async (heldBy: string | null, createdAgo: string) => {
      counter += 1;
      const definitionId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      await db.query(
        `insert into bakery.automation_definitions (id, organization_id, slug, name, description, enabled)
         values ($1, $2, $3, 'Clone', '', true)`,
        [definitionId, org, `clone-${counter}`],
      );
      await db.query(
        `insert into bakery.automation_versions (
           id, organization_id, automation_id, revision, trigger, workflow_version_id,
           actor_id, inputs, application_id, repository_id, budget_limit_usd, brief,
           misfire_policy, overlap_policy, digest
         ) select $1, organization_id, $2, 1, trigger, workflow_version_id, actor_id,
                  inputs, application_id, repository_id, budget_limit_usd, brief,
                  misfire_policy, overlap_policy, $3
             from bakery.automation_versions where id = $4`,
        [versionId, definitionId, `digest-clone-${counter}`, t.version.id],
      );
      await db.query(
        `update bakery.automation_definitions set active_version_id = $2 where id = $1`,
        [definitionId, versionId],
      );
      if (heldBy !== null) {
        await db.query(
          `insert into bakery.automation_firings (
             organization_id, automation_version_id, scheduled_at, status, pending,
             skipped_count, run_id
           ) values ($1, $2, '2026-11-01T01:00:00Z', 'started', false, 0, $3)`,
          [org, versionId, heldBy],
        );
      }
      const waiting = await db.query<{ id: string }>(
        `insert into bakery.automation_firings (
           organization_id, automation_version_id, scheduled_at, status, pending,
           skipped_count, created_at
         ) values ($1, $2, '2026-11-02T03:00:00Z', 'queued', true, 0,
                   now() - $3::interval)
         returning id`,
        [org, versionId, createdAgo],
      );
      return waiting.rows[0]!.id;
    };
    // BATCH automations are held by the active run and their waiting firings
    // are the oldest; one more is free and its waiting firing is the newest.
    const held: string[] = [];
    for (let i = 0; i < BATCH; i += 1) {
      held.push(await automation(runId, `${BATCH - i + 1} hours`));
    }
    const free = await automation(null, "0 seconds");
    const result = await promoteWaitingFirings({
      database: db,
      batch: BATCH,
    });
    // The held ones were not even looked at: the free one started.
    assertEquals(result, { started: 1, held: 0, refused: 0, errors: [] });
    const status = async (id: string) =>
      (await db.query<{ status: string; pending: boolean }>(
        `select status, pending from bakery.automation_firings where id = $1`,
        [id],
      )).rows[0];
    assertEquals(await status(free), { status: "started", pending: false });
    for (const id of held) {
      assertEquals(await status(id), { status: "queued", pending: true });
    }
    // Once the run ends they all start, in age order, in passes of three.
    await t.endRuns();
    const next = await promoteWaitingFirings({ database: db, batch: BATCH });
    assertEquals(next.started, BATCH);
  }));
