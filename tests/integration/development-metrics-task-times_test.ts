/**
 * #46 slice B against Postgres and the real route: a task's lead time and
 * where it went, from a real claimed attempt, its job's ready time and a
 * person wait, with deterministic timestamps. The parts never overlap and,
 * with "unaccounted", add up to the lead time; Blocked is unknown.
 */

import { assert, assertEquals } from "@std/assert";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

const T0 = Date.parse("2026-06-10T00:00:00Z");
const at = (hours: number) => new Date(T0 + hours * 3_600_000);

function get(fixture: Fixture, path: string, cookie = fixture.adminCookie) {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      headers: {
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: cookie,
      },
    }),
  ));
}

async function ok(response: Response): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, 200, text);
  return JSON.parse(text) as Json;
}

const window = "from=2026-06-01T00:00:00Z&to=2026-07-01T00:00:00Z";

Deno.test("a delivered task's lead time splits into queue, agent, person and unaccounted", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const worker = await registeredWorker(fixture, {
      name: "metrics-46",
      slots: 1,
    });
    const job = await seedEligibleNonmodelJob(
      db,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assert(assignment.attemptId, "the worker claimed the job");

    // Requested at 0h; ready at 1h, claimed and started at 2h, ended at 6h;
    // a person wait 5h-7h; the last run completed at 10h.
    await db.query(
      "update bakery.workflow_runs set created_at = $2, status = 'completed', finished_at = $3 where id = $1",
      [job.runId, at(0), at(10)],
    );
    await db.query(
      "update bakery.tasks set status = 'completed' where id = $1",
      [
        job.taskId,
      ],
    );
    await db.query(
      "update bakery.jobs set created_at = $2, available_at = $3 where id = $1",
      [job.jobId, at(0.5), at(1)],
    );
    await db.query(
      "update bakery.job_attempts set created_at = $2, started_at = $2, ended_at = $3 where id = $1",
      [assignment.attemptId, at(2), at(6)],
    );
    await db.query(
      "insert into bakery.run_waits (organization_id, run_id, step_key, kind, started_at, ended_at) values ($1, $2, 'approve', 'human.approval', $3, $4)",
      [fixture.organizationId, job.runId, at(5), at(7)],
    );

    const series = await ok(
      await get(
        fixture,
        "/v1/metrics?metric=tasks.leadTimeHours&resolution=day&" + window,
      ),
    );
    assertEquals(series.unit, "hours");
    const points = (series.points as { at: string; value: number | null }[])
      .filter((p) => p.value !== null);
    assertEquals(points.map((p) => [p.at, p.value]), [[
      "2026-06-10T00:00:00.000Z",
      10,
    ]]);
    const summary = series.summary as Json;
    assertEquals([summary.median, summary.p90, summary.mean], [10, 10, 10]);
    const parts = Object.fromEntries(
      (summary.breakdown as Json[]).map((b) => [b.category, b.hours]),
    );
    assertEquals(parts, {
      queue: 1,
      agentWorking: 3,
      review: 0,
      person: 2,
      blocked: null,
      unaccounted: 4,
    });
    assertEquals(summary.deliveryPoints, [
      { deliveryPoint: "merged_pull_request", count: 0 },
      { deliveryPoint: "completed_run", count: 1 },
    ]);

    const sources = await ok(
      await get(
        fixture,
        "/v1/metrics/sources?metric=tasks.leadTimeHours&" + window,
      ),
    );
    const rows = sources.items as Json[];
    assertEquals(rows.length, 1);
    assertEquals(
      [rows[0].kind, rows[0].id, rows[0].deliveryPoint, rows[0].value],
      ["task", job.taskId, "completed_run", 10],
    );
    assertEquals(
      (rows[0].waits as Json[]).find((w) => w.category === "blocked"),
      { category: "blocked", hours: null, unknownReason: "not_recorded" },
    );
  }));
