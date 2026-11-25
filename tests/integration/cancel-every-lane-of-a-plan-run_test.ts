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
import { authTestOrigin } from "../helpers/auth.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { requestRunPause } from "../../apps/server/src/modules/work/ticket-run-pause.ts";

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
  files: { read: ["inputs"], write: ["outputs"] },
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

Deno.test("a cancel reaches a lane held by a worker even when another lane's job is a retry waiting for its turn", () =>
  withWorkerFixture(async (fixture) => {
    // The first lane carries the fixture's own model job, which no worker can
    // claim here: two more lanes give two jobs a worker holds.
    const seeded = await seedGroup(fixture, [
      lane("lane_a", [check("a1")]),
      lane("lane_b", [check("b1")]),
      lane("lane_c", [check("c1")]),
    ]);
    const set = await seeded.repository.findNextSet(
      seeded.job.runId,
      seeded.owner,
    );
    await seeded.repository.admitSet(set, seeded.owner);
    const worker = await registeredWorker(fixture, {
      name: "cancel-retry-lane",
      slots: 2,
    });
    const live = await claimAssignment(fixture, worker);
    const retried = await claimAssignment(fixture, worker);
    // The second lane's attempt failed and its job waits to be tried again: a
    // queued job that already has an attempt.
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set status = 'failed'
        where job_id = $1`,
      [retried.jobId],
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'queued' where id = $1`,
      [retried.jobId],
    );

    const response = await adminRequest(
      fixture,
      `/v1/runs/${seeded.job.runId}/controls`,
      { action: "cancel" },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(response.status, 201, await response.clone().text());
    assertEquals((await state(fixture, seeded)).run.status, "canceled");
    assertEquals((await state(fixture, seeded)).task.status, "canceled");
    assertEquals(
      (await rows(fixture, seeded)).map((row) => row.status),
      ["canceled", "canceled", "canceled"],
    );
    assertEquals(
      (await jobsOf(fixture, seeded)).map((job) => job.status),
      ["canceled", "canceled", "canceled"],
    );
    // One completed event per canceled job that had an attempt, each naming its
    // own step.
    const events = await fixture.pgDatabase.query<
      { jobId: string; stepId: string | null }
    >(
      `select aggregate_id as "jobId", payload->>'stepId' as "stepId"
         from bakery.domain_events
        where organization_id = $1 and event_type = 'job.completed'
          and aggregate_id = any($2::uuid[])
        order by aggregate_id`,
      [fixture.organizationId, [live.jobId, retried.jobId]],
    );
    assertEquals(events.rows.length, 2);
    assert(events.rows.every((event) => event.stepId !== null));
    assertEquals(
      new Set(events.rows.map((event) => event.stepId)).size,
      2,
    );
  }));

async function twoHostLanes(
  fixture: WorkerFixture,
  hostCapabilities: [string[], string[]],
) {
  // The first lane carries the fixture's own model job, which no worker can
  // claim here: the other two are the lanes the two hosts hold.
  const seeded = await seedGroup(fixture, [
    lane("lane_a", [check("a1")]),
    lane("lane_b", [check("b1")]),
    lane("lane_c", [check("c1")]),
  ]);
  const set = await seeded.repository.findNextSet(
    seeded.job.runId,
    seeded.owner,
  );
  await seeded.repository.admitSet(set, seeded.owner);
  const workers = [
    await registeredWorker(fixture, { name: "lane-host-a" }),
    await registeredWorker(fixture, { name: "lane-host-b" }),
  ];
  for (const [index, worker] of workers.entries()) {
    await fixture.pgDatabase.query(
      `update bakery.worker_hosts set adapter_capabilities = $2::jsonb where id = $1`,
      [
        worker.registration.workerHostId,
        JSON.stringify(hostCapabilities[index]),
      ],
    );
    await claimAssignment(fixture, worker);
  }
  return seeded;
}

const controlRead = async (fixture: WorkerFixture, runId: string) => {
  const response = await fixture.app.fetch(
    new Request(`${authTestOrigin}/v1/runs/${runId}/controls`, {
      headers: {
        cookie: fixture.adminCookie,
        "Bakery-Organization-Id": fixture.organizationId,
      },
    }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json() as {
    actions: { action: string; canRequest: boolean; reason: string }[];
  }).actions;
};

const commandCount = async (fixture: WorkerFixture) =>
  Number(
    (await fixture.pgDatabase.query<{ count: string }>(
      `select count(*) from bakery.worker_commands where organization_id = $1`,
      [fixture.organizationId],
    )).rows[0].count,
  );

Deno.test("the controls read and the action agree on a run whose lanes are on hosts with different adapters", () =>
  withWorkerFixture(async (fixture) => {
    // Host A steers, host B does not.
    const seeded = await twoHostLanes(fixture, [
      ["steer", "follow_up"],
      ["follow_up"],
    ]);
    const read = await controlRead(fixture, seeded.job.runId);
    const pause = read.find((entry) => entry.action === "pause")!;
    // A pause could not reach both lanes: the read says so, and so does the action.
    assertEquals([pause.canRequest, pause.reason], [false, "unsupported"]);
    assertEquals(
      read.find((entry) => entry.action === "cancel")?.canRequest,
      true,
    );
    const refused = await adminRequest(
      fixture,
      `/v1/runs/${seeded.job.runId}/controls`,
      { action: "pause" },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(refused.status, 409);
    assertEquals(await commandCount(fixture), 0);

    // Both steer: the read allows it and the action commands each lane once.
    await fixture.pgDatabase.query(
      `update bakery.worker_hosts set adapter_capabilities = '["steer","follow_up"]'::jsonb
        where organization_id = $1`,
      [fixture.organizationId],
    );
    const both = await controlRead(fixture, seeded.job.runId);
    assertEquals(
      both.find((entry) => entry.action === "pause")?.canRequest,
      true,
    );
    const paused = await adminRequest(
      fixture,
      `/v1/runs/${seeded.job.runId}/controls`,
      { action: "pause" },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(paused.status, 201, await paused.clone().text());
    assertEquals(await commandCount(fixture), 2);
  }));

Deno.test("a ticket pause commands every live lane, and none when one lane's host cannot steer", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await twoHostLanes(fixture, [
      ["steer", "follow_up"],
      ["follow_up"],
    ]);
    const request = (version: number) =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          requestRunPause(transaction, {
            organizationId: fixture.organizationId,
            runId: seeded.job.runId,
            traceId: crypto.randomUUID(),
            requestId: "ticket-request",
            version,
          }),
      );
    assertEquals(await request(1), { requested: false, reason: "unsupported" });
    assertEquals(await commandCount(fixture), 0);

    await fixture.pgDatabase.query(
      `update bakery.worker_hosts set adapter_capabilities = '["steer","follow_up"]'::jsonb
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(await request(1), { requested: true });
    assertEquals(await commandCount(fixture), 2);
    // The same version again enqueues nothing more.
    assertEquals(await request(1), { requested: true });
    assertEquals(await commandCount(fixture), 2);
  }));
