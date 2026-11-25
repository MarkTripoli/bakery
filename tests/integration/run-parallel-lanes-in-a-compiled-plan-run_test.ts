import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Inngest } from "inngest";
import { createBakeryFixedWorkflow } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  rows,
  type Seeded,
  seedPlanRun,
  setRow,
  state,
} from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { compiled, noop, type Step } from "../helpers/workflow-interpreter.ts";

// #30 E4c. For a plan run pinned to interpreter revision 2 the engine runs a
// parallel group: findNextSet answers with one next step for each running lane
// (rows appended on demand, idempotently), every job of the set is admitted
// before the first is waited for, a failed lane stops only its dependants, and
// the run ends when nothing can still run.

const lane = (id: string, steps: Step[], needs: string[] = []): Step => ({
  id,
  repository: "repo",
  ...(needs.length === 0 ? {} : { needs }),
  steps,
});

const group = (lanes: Step[], maxConcurrency = 2): Step => ({
  id: "fan",
  parallel: {
    maxConcurrency,
    join: "all-required",
    failurePolicy: "stop-dependent",
    branches: lanes,
  },
});

/** A step a worker can run: a quality check of the run's own repository. */
const check = (id: string, extra: Step = {}): Step => ({
  id,
  uses: "quality.check",
  with: { repositoryId: "$input.repo", revision: "abc" },
  checks: ["fmt"],
  files: { read: ["inputs"], write: ["outputs"] },
  ...extra,
});

const inputs = { repo: { type: "uuid", required: true } } as const;

const plan = () =>
  compiled([
    group([
      lane("lane_a", [check("a1"), check("a2")]),
      lane("lane_b", [check("b1")]),
    ]),
    check("after", { needs: ["fan"] }),
  ], inputs);

/** Seeds the run with the repository input pointing at the run's own repository. */
async function seedRun(
  fixture: WorkerFixture,
  document: Awaited<ReturnType<typeof plan>>,
) {
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

const keysOf = (keys: readonly { stepKey: string }[]) =>
  keys.map((key) => key.stepKey);

const jobCount = async (fixture: WorkerFixture, seeded: Seeded) =>
  Number(
    (await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
      where step.run_id = $1`,
      [seeded.job.runId],
    )).rows[0].count,
  );

Deno.test("a new plan run is pinned to revision 3, which runs groups as revision 2 did, and a group answers with one step per running lane, idempotently", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await plan());
    const pin = (await fixture.pgDatabase.query<
      { revision: string }
    >(
      `select snapshot #>> '{runtime,pin,interpreterRevision}' as revision
         from bakery.workflow_runs where id = $1`,
      [seeded.job.runId],
    )).rows[0].revision;
    assertEquals(pin, "4");

    const set = await seeded.repository.findNextSet(
      seeded.job.runId,
      seeded.owner,
    );
    assertEquals(keysOf(set), ["fan.lane_a.a1", "fan.lane_b.b1"]);
    assertEquals(
      (await rows(fixture, seeded)).map((row) => [row.stepKey, row.status]),
      [["fan.lane_a.a1", "running"], ["fan.lane_b.b1", "pending"]],
    );
    // Asked again, with both in flight: the same set, no new rows.
    assertEquals(
      keysOf(
        await seeded.repository.findNextSet(seeded.job.runId, seeded.owner),
      ),
      ["fan.lane_a.a1", "fan.lane_b.b1"],
    );
    assertEquals((await rows(fixture, seeded)).length, 2);
    // findNext still answers one key, the first.
    assertEquals(
      (await seeded.repository.findNext(seeded.job.runId, seeded.owner))
        ?.stepKey,
      "fan.lane_a.a1",
    );
    assertEquals((await state(fixture, seeded)).run.status, "running");
  }));

Deno.test("the jobs of a whole set are admitted together, once", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await plan());
    const set = await seeded.repository.findNextSet(
      seeded.job.runId,
      seeded.owner,
    );
    // The fixture's own job belongs to the first step.
    assertEquals(await jobCount(fixture, seeded), 1);
    await seeded.repository.admitSet(set, seeded.owner);
    assertEquals(await jobCount(fixture, seeded), 2);
    await seeded.repository.admitSet(set, seeded.owner);
    assertEquals(await jobCount(fixture, seeded), 2);
  }));

Deno.test("lanes advance on their own, the set shrinks as they end, the join waits for all, and the run completes", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await plan());
    const next = async () =>
      keysOf(
        await seeded.repository.findNextSet(seeded.job.runId, seeded.owner),
      );
    assertEquals(await next(), ["fan.lane_a.a1", "fan.lane_b.b1"]);
    await setRow(fixture, seeded, "fan.lane_a.a1", "completed", { n: "a1" });
    assertEquals(await next(), ["fan.lane_a.a2", "fan.lane_b.b1"]);
    await setRow(fixture, seeded, "fan.lane_b.b1", "completed", { n: "b1" });
    assertEquals(await next(), ["fan.lane_a.a2"]);
    await setRow(fixture, seeded, "fan.lane_a.a2", "completed", { n: "a2" });
    assertEquals(await next(), ["after"]);
    await setRow(fixture, seeded, "after", "completed", {});
    assertEquals(await next(), []);
    assertEquals((await state(fixture, seeded)).run.status, "completed");
    assertEquals((await state(fixture, seeded)).task.status, "completed");
  }));

Deno.test("a failed lane stops only its dependants: the other lane runs to its end, then the run fails", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(
      fixture,
      await compiled([
        group([
          lane("lane_a", [check("a1"), check("a2")]),
          lane("lane_b", [check("b1"), check("b2")]),
          lane("lane_c", [check("c1")], ["lane_a"]),
        ]),
        check("after", { needs: ["fan"] }),
      ], inputs),
    );
    const next = async () =>
      keysOf(
        await seeded.repository.findNextSet(seeded.job.runId, seeded.owner),
      );
    assertEquals(await next(), ["fan.lane_a.a1", "fan.lane_b.b1"]);
    await setRow(fixture, seeded, "fan.lane_a.a1", "failed");
    // A is over (its a2 never runs), C needs A and never starts, B goes on.
    assertEquals(await next(), ["fan.lane_b.b1"]);
    await setRow(fixture, seeded, "fan.lane_b.b1", "completed", {});
    assertEquals(await next(), ["fan.lane_b.b2"]);
    assertEquals((await state(fixture, seeded)).run.status, "running");
    await setRow(fixture, seeded, "fan.lane_b.b2", "completed", {});
    assertEquals(await next(), []);
    assertEquals((await state(fixture, seeded)).run.status, "failed");
    assertEquals(
      (await rows(fixture, seeded)).map((row) => row.stepKey).sort(),
      ["fan.lane_a.a1", "fan.lane_b.b1", "fan.lane_b.b2"],
    );
  }));

Deno.test("a wait in a lane is part of the set and has no job: admitting the set leaves it alone", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(
      fixture,
      await compiled([
        group([
          lane("lane_b", [check("b1")]),
          lane("lane_w", [
            { id: "pause", wait: { duration: "1s" } },
            check("w2"),
          ]),
        ]),
      ], inputs),
    );
    const set = await seeded.repository.findNextSet(
      seeded.job.runId,
      seeded.owner,
    );
    assertEquals(keysOf(set), ["fan.lane_b.b1", "fan.lane_w.pause"]);
    assertEquals(
      (await rows(fixture, seeded)).map((row) => [row.stepKey, row.status]),
      [["fan.lane_b.b1", "running"], ["fan.lane_w.pause", "waiting"]],
    );
    // The first step has the fixture's job already; the wait never has one.
    assertEquals(await jobCount(fixture, seeded), 1);
    await seeded.repository.admitSet(set, seeded.owner);
    assertEquals(await jobCount(fixture, seeded), 1);
    assert(
      (await seeded.repository.readWait(set[1]!, seeded.owner)) !== null,
      "the wait is still a wait",
    );
  }));

Deno.test("a lane whose step is running holds its slot when other lanes become ready", () =>
  withWorkerFixture(async (fixture) => {
    // E and F need P; Z runs; room for two lanes.
    const seeded = await seedRun(
      fixture,
      await compiled([
        group([
          lane("lane_e", [check("e1")], ["lane_p"]),
          lane("lane_f", [check("f1")], ["lane_p"]),
          lane("lane_z", [check("z1"), check("z2")]),
          lane("lane_p", [check("p1")]),
        ]),
      ], inputs),
    );
    const next = async () =>
      keysOf(
        await seeded.repository.findNextSet(seeded.job.runId, seeded.owner),
      );
    assertEquals(await next(), ["fan.lane_z.z1", "fan.lane_p.p1"]);
    await setRow(fixture, seeded, "fan.lane_p.p1", "completed", {});
    // E and F are ready, Z is running: Z keeps its slot, E takes the other.
    assertEquals(await next(), ["fan.lane_e.e1", "fan.lane_z.z1"]);
  }));

// --- the engine function, driven with a fake step

type Handler = (
  context: { event: unknown; step: FakeStep },
) => Promise<unknown>;
type FakeStep = {
  run<T>(id: string, work: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
  waitForEvent(id: string, options: unknown): Promise<unknown>;
  sendEvent(id: string, event: unknown): Promise<void>;
};
class Stop extends Error {}

function engineFor(
  fixture: WorkerFixture,
  extra: { stepOperationBudget?: number } = {},
): { handler: Handler } {
  const captured: { handler?: Handler } = {};
  const client = {
    createFunction(_config: unknown, handler: Handler) {
      captured.handler = handler;
      return {};
    },
  } as unknown as Inngest;
  createBakeryFixedWorkflow({
    client,
    database: fixture.pgDatabase,
    maxAttempts: 3,
    waitMs: 10,
    jobCompletionTimeout: "1m",
    engineRetries: 3,
    ...extra,
  });
  assert(captured.handler !== undefined);
  return { handler: captured.handler };
}

Deno.test("the engine admits every job of a set before it waits for the first", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await plan());
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);
    const record: string[] = [];
    const jobsAtFirstWait: number[] = [];
    const step: FakeStep = {
      run: async (id, work) => {
        record.push(id);
        return JSON.parse(JSON.stringify((await work()) ?? null));
      },
      sleep: (id) => {
        record.push(id);
        return Promise.resolve();
      },
      waitForEvent: async (id) => {
        record.push(id);
        jobsAtFirstWait.push(await jobCount(fixture, seeded));
        throw new Stop();
      },
      sendEvent: (id) => {
        record.push(id);
        return Promise.resolve();
      },
    };
    await assertRejects(
      () =>
        handler({
          event: {
            id: `e4c-${crypto.randomUUID()}`,
            data: { payload: { runId: seeded.job.runId } },
          },
          step,
        }),
      Stop,
    );
    const admitAt = record.indexOf("admit-workflow-steps-0");
    const waitAt = record.findIndex((id) => id.startsWith("wait-for-job-"));
    assert(admitAt >= 0, "the set is admitted");
    assert(waitAt > admitAt, "and only then is the first job waited for");
    // Both lanes' jobs existed when the first wait began.
    assertEquals(jobsAtFirstWait, [2]);
    assertEquals(
      (await rows(fixture, seeded)).map((row) => row.stepKey),
      ["fan.lane_a.a1", "fan.lane_b.b1"],
    );
  }));

Deno.test("a run that is not in a group is answered as before: one step, no set admission", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(
      fixture,
      await compiled([noop("first"), noop("second", { needs: ["first"] })]),
    );
    const set = await seeded.repository.findNextSet(
      seeded.job.runId,
      seeded.owner,
    );
    assertEquals(keysOf(set), ["first"]);
    await setRow(fixture, seeded, "first", "completed", {});
    assertEquals(
      keysOf(
        await seeded.repository.findNextSet(seeded.job.runId, seeded.owner),
      ),
      ["second"],
    );
  }));

type Hooks = {
  /** Called at each wait for a job or a timer, with its 1-based number. */
  waited?: (number: number, id: string) => Promise<void>;
  /** The options of each event wait, as the function gave them. */
  waitOptions?: { timeout?: string; if?: string }[];
  /** Called just before a durable `run` step does its work. */
  beforeRun?: (id: string) => Promise<void>;
};

/** A fake step that counts and records every durable operation. */
function recordingStep(record: string[], hooks: Hooks = {}): FakeStep {
  let waits = 0;
  const wait = async (id: string) => {
    record.push(id);
    waits += 1;
    await hooks.waited?.(waits, id);
  };
  return {
    run: async (id, work) => {
      record.push(id);
      await hooks.beforeRun?.(id);
      return JSON.parse(JSON.stringify((await work()) ?? null));
    },
    sleep: (id) => wait(id),
    waitForEvent: async (id, options) => {
      hooks.waitOptions?.push(options as { timeout?: string; if?: string });
      await wait(id);
      return null;
    },
    sendEvent: (id) => {
      record.push(id);
      return Promise.resolve();
    },
  };
}

const eventFor = (runId: string) => ({
  id: `e4c-${crypto.randomUUID()}`,
  data: { payload: { runId } },
});

Deno.test("a lane whose step finished advances at once: its next job exists while the other lane's step still runs", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await plan());
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);
    const seen: { rows: string[][]; jobs: number }[] = [];
    const step = recordingStep([], {
      waited: async (number) => {
        if (number === 1) {
          // a1 ends; b1 is still running.
          await setRow(fixture, seeded, "fan.lane_a.a1", "completed", {});
          return;
        }
        seen.push({
          rows: (await rows(fixture, seeded)).map((
            row,
          ) => [row.stepKey, row.status]),
          jobs: await jobCount(fixture, seeded),
        });
        throw new Stop();
      },
    });
    await assertRejects(
      () => handler({ event: eventFor(seeded.job.runId), step }),
      Stop,
    );
    // At the second wait: a2 has its row and its job though b1 has not ended.
    assertEquals(seen[0]!.rows, [
      ["fan.lane_a.a1", "completed"],
      ["fan.lane_b.b1", "running"],
      ["fan.lane_a.a2", "running"],
    ]);
    assertEquals(seen[0]!.jobs, 3);
  }));

Deno.test("a failed lane does not end the function run: the others are driven on and the function itself ends the run failed", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(
      fixture,
      await compiled([
        group([
          lane("lane_a", [check("a1"), check("a2")]),
          lane("lane_b", [check("b1"), check("b2")]),
          lane("lane_c", [check("c1")], ["lane_a"]),
        ]),
        check("after", { needs: ["fan"] }),
      ], inputs),
    );
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);
    const statuses: string[] = [];
    const step = recordingStep([], {
      waited: async (number) => {
        statuses.push((await state(fixture, seeded)).run.status);
        if (number === 1) {
          await setRow(fixture, seeded, "fan.lane_a.a1", "failed");
        } else {
          // The last lane running fails too, while the function waits for
          // it alone: the function itself projects the end of the run.
          await setRow(fixture, seeded, "fan.lane_b.b1", "failed");
        }
      },
    });
    // The one function run carried the run to its end (no second engine run).
    await handler({ event: eventFor(seeded.job.runId), step });
    assertEquals(statuses, ["running", "running"]);
    assertEquals((await state(fixture, seeded)).run.status, "failed");
    assertEquals((await state(fixture, seeded)).task.status, "failed");
    assertEquals(
      (await rows(fixture, seeded)).map((row) => [row.stepKey, row.status]),
      [
        ["fan.lane_a.a1", "failed"],
        ["fan.lane_b.b1", "failed"],
      ],
    );
  }));

const wide = () =>
  compiled([
    group(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
        lane(`lane_${id}`, [check(`${id}1`), check(`${id}2`), check(`${id}3`)])
      ),
      8,
    ),
  ], inputs);

Deno.test("worst case: a full-width pass is a handful of operations, and a function run hands off before the operation budget", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await wide());
    await seeded.repository.releaseEngineOwner(seeded.owner);
    // A budget small enough to reach: nothing ever completes, so every pass
    // waits and asks again, and the run must be handed on, not left to run
    // past what one function run may do.
    const { handler } = engineFor(fixture, { stepOperationBudget: 60 });
    const record: string[] = [];
    const result = await handler({
      event: eventFor(seeded.job.runId),
      step: recordingStep(record),
    });
    assertEquals(result, { status: "handoff" });
    // The first pass over all eight lanes: acquire, run kind, answer, admit
    // set, one read per lane, stretch, wait: 15 operations, not 34.
    const firstWait = record.findIndex((id) => id.startsWith("wait-for-job-"));
    assert(
      firstWait + 1 <= 16,
      `${firstWait + 1} operations in the first pass`,
    );
    // And it stopped at the budget plus the longest pass and the hand-off.
    assert(record.length >= 60, String(record.length));
    assert(record.length <= 60 + 20, String(record.length));
    // The default budget leaves room for the longest pass under the design's
    // 1,000 steps per function.
    assert(900 + 40 + 20 <= 1000);
  }));

Deno.test("one wait serves the whole set: any of its jobs, or the soonest retry", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await plan());
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);
    // The first pass admits both jobs; then a1's job is made retryable (due
    // again in half a minute) while b1's is still running.
    const options: { timeout?: string; if?: string }[] = [];
    const step = recordingStep([], {
      waitOptions: options,
      waited: (number) => {
        if (number === 1) throw new Stop();
        return Promise.resolve();
      },
    });
    await assertRejects(
      () => handler({ event: eventFor(seeded.job.runId), step }),
      Stop,
    );
    const jobs = (await fixture.pgDatabase.query<{ id: string; key: string }>(
      `select job.id, step.step_key as key
         from bakery.jobs job
         join bakery.run_steps step
           on step.organization_id = job.organization_id
          and step.id = job.run_step_id
        where step.run_id = $1 order by step.position`,
      [seeded.job.runId],
    )).rows;
    assertEquals(jobs.map((job) => job.key), [
      "fan.lane_a.a1",
      "fan.lane_b.b1",
    ]);
    // One wait for both jobs, as an or, bounded by the job timeout.
    assertEquals(options.length, 1);
    for (const job of jobs) assert(options[0]!.if!.includes(`'${job.id}'`));
    assert(options[0]!.if!.includes(" || "));
    assertEquals(options[0]!.timeout, "60000ms");

    // Now a1 is a retry due soon: the same single wait is cut to that time.
    await fixture.pgDatabase.query(
      `update bakery.jobs set available_at = clock_timestamp() + interval '30 seconds'
        where id = $1`,
      [jobs[0]!.id],
    );
    const later: { timeout?: string; if?: string }[] = [];
    const again = recordingStep([], {
      waitOptions: later,
      waited: () => {
        throw new Stop();
      },
    });
    await seeded.repository.releaseEngineOwner(
      (await seeded.repository.acquireEngineOwner(
        seeded.job.runId,
        `again-${crypto.randomUUID()}`,
        60_000,
      ))!,
    );
    await assertRejects(
      () => handler({ event: eventFor(seeded.job.runId), step: again }),
      Stop,
    );
    // waitMs of the function is 10 ms: the retry delay is capped to it.
    assertEquals(later.length, 1);
    assertEquals(later[0]!.timeout, "10ms");
    assert(later[0]!.if!.includes(`'${jobs[1]!.id}'`));
    assert(!later[0]!.if!.includes(`'${jobs[0]!.id}'`));
  }));

Deno.test("a step that failed between the answer and the pass is not a surprise: the set pass moves on and the next answer projects it", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await plan());
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);
    const record: string[] = [];
    let failedOnce = false;
    const step = recordingStep(record, {
      // After the answer and the admission, before the first read of the pass.
      beforeRun: async (id) => {
        if (id.startsWith("read-wait-0-") && !failedOnce) {
          failedOnce = true;
          await setRow(fixture, seeded, "fan.lane_a.a1", "failed");
        }
      },
      waited: () => {
        throw new Stop();
      },
    });
    await assertRejects(
      () => handler({ event: eventFor(seeded.job.runId), step }),
      Stop,
    );
    // The pass that saw a1 failed did not wait; the next answer had no a1 and
    // the function waited for the rest (b1) once.
    assertEquals(
      record.filter((id) => id.startsWith("load-next-workflow-step-")),
      ["load-next-workflow-step-0", "load-next-workflow-step-1"],
    );
    assertEquals(
      record.filter((id) => id.startsWith("wait-for-job-")).length,
      1,
    );
    assert(record.indexOf("wait-for-job-1-fan.lane_b.b1-0") >= -1);
  }));

const requestCancel = (
  fixture: WorkerFixture,
  seeded: Seeded,
  stepKey: string,
) =>
  fixture.pgDatabase.query(
    `update bakery.jobs set cancel_requested_at = clock_timestamp()
      where run_step_id = (
        select id from bakery.run_steps where run_id = $1 and step_key = $2)`,
    [seeded.job.runId, stepKey],
  );

/** A cancel is requested on the first step's job and the worker has not stopped it. */
async function cancelRequestedNotYetActedOn(
  fixture: WorkerFixture,
  document: Awaited<ReturnType<typeof plan>>,
) {
  const seeded = await seedRun(fixture, document);
  await seeded.repository.releaseEngineOwner(seeded.owner);
  const { handler } = engineFor(fixture);
  await requestCancel(fixture, seeded, seeded.firstKey);
  const record: string[] = [];
  const result = await handler({
    event: eventFor(seeded.job.runId),
    step: recordingStep(record),
  });
  // Back to the caller at once, naming the cancel: no wait, no second pass.
  assertEquals(result, { status: "failed", reason: "cancel_requested_at" });
  assertEquals(
    record.filter((id) => id.startsWith("load-next-workflow-step-")),
    ["load-next-workflow-step-0"],
  );
  assert(record.length <= 14, `${record.length} operations`);
  assertEquals((await state(fixture, seeded)).run.status, "running");
  // The owner is released so the cancel (or recovery) takes it from here.
  assertEquals((await state(fixture, seeded)).run.owner, null);
}

Deno.test("a cancel the worker has not acted on yet ends the pass of a set: the function neither spins nor goes on", () =>
  withWorkerFixture(async (fixture) => {
    await cancelRequestedNotYetActedOn(fixture, await plan());
  }));

Deno.test("a cancel the worker has not acted on yet ends a sequential plan run's pass as well", () =>
  withWorkerFixture(async (fixture) => {
    await cancelRequestedNotYetActedOn(
      fixture,
      await compiled([
        check("first"),
        check("second", { needs: ["first"] }),
      ], inputs),
    );
  }));
