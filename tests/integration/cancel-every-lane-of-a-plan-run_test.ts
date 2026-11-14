import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";
import {
  adminRequest,
  registeredWorker,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { rows, type Seeded, seedPlanRun, state } from "../helpers/plan-run.ts";
import { compiled, type Step } from "../helpers/workflow-interpreter.ts";

// #30 E4d. A run control `cancel` on a plan run reaches every live attempt
// (a lane each) and ends everything the run still holds: queued jobs, steps
// not yet admitted and waits, not only the first attempt's step.

const lane = (id: string, steps: Step[]): Step => ({
  id,
  repository: "repo",
  steps,
});
const check = (id: string): Step => ({
  id,
  uses: "quality.check",
  with: { repositoryId: "$input.repo", revision: "abc" },
  checks: ["fmt"],
});
const inputs = { repo: { type: "uuid", required: true } } as const;

async function seedGroup(fixture: WorkerFixture, lanes: Step[]) {
  const document = await compiled([
    {
      id: "fan",
      parallel: {
        maxConcurrency: lanes.length,
        join: "all-required",
        failurePolicy: "stop-dependent",
        branches: lanes,
      },
    },
  ], inputs);
  const seeded = await seedPlanRun(fixture, document, {
    inputs: { repo: "00000000-0000-4000-8000-0000000000a1" },
  });
  const repo = (await fixture.pgDatabase.query<{ repositoryId: string }>(
    `select repository_id as "repositoryId" from bakery.workflow_runs where id = $1`,
    [seeded.job.runId],
  )).rows[0].repositoryId;
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs
        set snapshot = jsonb_set(snapshot, '{inputs,repo}', to_jsonb($2::text))
      where id = $1`,
    [seeded.job.runId, repo],
  );
  return seeded;
}

const jobsOf = async (fixture: WorkerFixture, seeded: Seeded) =>
  (await fixture.pgDatabase.query<
    { key: string; status: string; attempts: string[] }
  >(
    `select step.step_key as key, job.status,
            coalesce(array_agg(attempt.status) filter (where attempt.id is not null), '{}') as attempts
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       left join bakery.job_attempts attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id
      where step.run_id = $1
      group by step.step_key, job.status, step.position
      order by step.position`,
    [seeded.job.runId],
  )).rows;

Deno.test("a cancel reaches every live attempt of a plan run and ends its queued jobs, waits and open steps", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGroup(fixture, [
      lane("lane_a", [check("a1")]),
      lane("lane_b", [check("b1")]),
      lane("lane_d", [check("d1")]),
      lane("lane_w", [{ id: "pause", wait: { duration: "1s" } }]),
    ]);
    const set = await seeded.repository.findNextSet(
      seeded.job.runId,
      seeded.owner,
    );
    assertEquals(set.map((key) => key.stepKey).sort(), [
      "fan.lane_a.a1",
      "fan.lane_b.b1",
      "fan.lane_d.d1",
      "fan.lane_w.pause",
    ]);
    await seeded.repository.admitSet(set, seeded.owner);
    // Two lanes are running on a worker; the third's job is still queued.
    const worker = await registeredWorker(fixture, {
      name: "cancel-lanes",
      slots: 3,
    });
    await claimAssignment(fixture, worker);
    await claimAssignment(fixture, worker);
    const before = await jobsOf(fixture, seeded);
    assertEquals(before.filter((job) => job.status === "queued").length, 1);
    assertEquals(
      before.filter((job) => job.attempts.length > 0).length,
      2,
    );

    const response = await adminRequest(
      fixture,
      `/v1/runs/${seeded.job.runId}/controls`,
      { action: "cancel" },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(response.status, 201, await response.clone().text());
    assertEquals(
      (await response.json() as { status: string }).status,
      "canceled",
    );

    // Everything the run held is over: jobs, attempts, steps (the wait too).
    const after = await jobsOf(fixture, seeded);
    assertEquals(after.map((job) => job.status), [
      "canceled",
      "canceled",
      "canceled",
    ]);
    for (const job of after) {
      assert(
        job.attempts.every((status) => status === "canceled"),
        `${job.key}: ${job.attempts.join(",")}`,
      );
    }
    assertEquals(
      (await rows(fixture, seeded)).map((row) => [row.stepKey, row.status]),
      [
        ["fan.lane_a.a1", "canceled"],
        ["fan.lane_b.b1", "canceled"],
        ["fan.lane_d.d1", "canceled"],
        ["fan.lane_w.pause", "canceled"],
      ],
    );
    assertEquals((await state(fixture, seeded)).run.status, "canceled");
    assertEquals((await state(fixture, seeded)).task.status, "canceled");
  }));

Deno.test("a cancel of a plan run that no worker holds ends its queued jobs and its waits as well", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGroup(fixture, [
      lane("lane_a", [check("a1")]),
      lane("lane_b", [check("b1")]),
      lane("lane_w", [{ id: "pause", wait: { duration: "1s" } }]),
    ]);
    const set = await seeded.repository.findNextSet(
      seeded.job.runId,
      seeded.owner,
    );
    await seeded.repository.admitSet(set, seeded.owner);
    const response = await adminRequest(
      fixture,
      `/v1/runs/${seeded.job.runId}/controls`,
      { action: "cancel" },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(response.status, 201, await response.clone().text());
    assertEquals(
      (await jobsOf(fixture, seeded)).map((job) => job.status),
      ["canceled", "canceled"],
    );
    assertEquals(
      (await rows(fixture, seeded)).map((row) => row.status),
      ["canceled", "canceled", "canceled"],
    );
    assertEquals((await state(fixture, seeded)).run.status, "canceled");
  }));
