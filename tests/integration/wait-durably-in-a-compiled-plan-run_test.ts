import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Inngest } from "inngest";
import { createBakeryFixedWorkflow } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { cancelRunWithoutAttempt } from "../../apps/server/src/modules/execution/coordination.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  rows,
  type Seeded,
  seedPlanRun,
  setRow,
  state,
} from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";

// #30 E4a. A duration wait in a compiled-plan run is a step row without a job.
// Its start is the database clock at the first insert and never moves, the
// engine sleeps what is left of it with the owner lease stretched over the
// sleep, and the row ends completed with `{outcome: "elapsed"}`, which the
// steps after it can read. A restart sleeps only the remainder.

const plan = () =>
  compiled([
    noop("first"),
    { id: "pause", needs: ["first"], wait: { duration: "1s" } },
    noop("after", { needs: ["pause"], with: { got: "$step.pause.outcome" } }),
  ]);

/** The same plan without the step after the wait: the wait is its last step. */
const shortPlan = () =>
  compiled([
    noop("first"),
    { id: "pause", needs: ["first"], wait: { duration: "1s" } },
  ]);

/** A wait too long for host load to outlast: for the tests that count what is left of it. */
const longPlan = () =>
  compiled([
    noop("first"),
    { id: "pause", needs: ["first"], wait: { duration: "30s" } },
  ]);

/** The plan with its first step done, so the wait is the next dispatch. */
async function atTheWait(
  fixture: WorkerFixture,
  makePlan: typeof plan = plan,
) {
  const seeded = await seedPlanRun(fixture, await makePlan());
  await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 1 });
  const key = await seeded.repository.findNext(seeded.job.runId, seeded.owner);
  assert(key !== undefined, "the plan reaches the wait");
  assertEquals(key.stepKey, "pause");
  return { seeded, key };
}

const waitRow = async (fixture: WorkerFixture, seeded: Seeded) =>
  (await fixture.pgDatabase.query<{
    id: string;
    status: string;
    output: unknown;
    startedAt: string | null;
    finishedAt: string | null;
    version: number;
    dispatch: { kind: string; wait: { kind: string; durationMs: number } };
  }>(
    `select id, status, output, started_at::text as "startedAt",
            finished_at::text as "finishedAt", version, dispatch
       from bakery.run_steps where run_id = $1 and step_key = 'pause'`,
    [seeded.job.runId],
  )).rows[0];

const backdate = (fixture: WorkerFixture, seeded: Seeded, ms: number) =>
  fixture.pgDatabase.query(
    `update bakery.run_steps
        set started_at = started_at - ($2::integer * interval '1 millisecond')
      where run_id = $1 and step_key = 'pause'`,
    [seeded.job.runId, ms],
  );

Deno.test("a duration wait is a row without a job, found again and again with the same start", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded, key } = await atTheWait(fixture);
    const before = await waitRow(fixture, seeded);
    assertEquals(before.status, "waiting");
    assert(before.startedAt !== null, "its start is recorded");
    assertEquals(before.dispatch.kind, "wait");
    assertEquals(before.dispatch.wait, { kind: "duration", durationMs: 1000 });
    assertEquals(
      (await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.jobs where run_step_id = $1`,
        [before.id],
      )).rows[0].count,
      "0",
    );
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, seeded.owner),
      key,
    );
    const after = await waitRow(fixture, seeded);
    assertEquals(after.startedAt, before.startedAt);
    assertEquals((await rows(fixture, seeded)).length, 2);
    assertEquals((await state(fixture, seeded)).run.status, "running");
  }));

Deno.test("what is left of a wait is read from the database clock, and it is only recorded elapsed once it has passed", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded, key } = await atTheWait(fixture);
    const boundary = await seeded.repository.readWait(key, seeded.owner);
    assert(boundary !== null);
    assertEquals(boundary.durationMs, 1000);
    assert(
      boundary.remainingMs > 0 && boundary.remainingMs <= 1000,
      String(boundary.remainingMs),
    );
    // Not due: refused, and the row is untouched.
    await assertRejects(
      () => seeded.repository.completeWait(key, seeded.owner),
      Error,
      "WORKFLOW_WAIT_NOT_DUE",
    );
    assertEquals((await waitRow(fixture, seeded)).status, "waiting");
    // Half gone.
    await backdate(fixture, seeded, 600);
    const half = await seeded.repository.readWait(key, seeded.owner);
    assert(half !== null && half.remainingMs <= 400, JSON.stringify(half));
    // Gone.
    await backdate(fixture, seeded, 1500);
    assertEquals(
      await seeded.repository.readWait(key, seeded.owner),
      { durationMs: 1000, remainingMs: 0 },
    );
    assertEquals(await seeded.repository.completeWait(key, seeded.owner), true);
    const done = await waitRow(fixture, seeded);
    assertEquals(done.status, "completed");
    assertEquals(done.output, { outcome: "elapsed" });
    assert(done.finishedAt !== null);
    // A replay is a no-op that still says completed.
    assertEquals(await seeded.repository.completeWait(key, seeded.owner), true);
    assertEquals((await waitRow(fixture, seeded)).version, done.version);
    // An action step is not a wait.
    assertEquals(
      await seeded.repository.readWait(
        { ...key, stepKey: seeded.firstKey },
        seeded.owner,
      ),
      null,
    );
  }));

Deno.test("the step after a wait reads its outcome", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded, key } = await atTheWait(fixture);
    await backdate(fixture, seeded, 2000);
    assertEquals(await seeded.repository.completeWait(key, seeded.owner), true);
    const next = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assert(next !== undefined);
    assertEquals(next.stepKey, "after");
    const all = await rows(fixture, seeded);
    assertEquals(all.map((row) => [row.stepKey, row.status]), [
      [seeded.firstKey, "completed"],
      ["pause", "completed"],
      ["after", "pending"],
    ]);
    assertEquals(all[2].input, { got: "elapsed" });
  }));

Deno.test("a wait is not completed under a canceled run", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded, key } = await atTheWait(fixture);
    await backdate(fixture, seeded, 2000);
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        cancelRunWithoutAttempt(transaction, {
          organizationId: fixture.organizationId,
          runId: seeded.job.runId,
          traceId: crypto.randomUUID(),
        }),
    );
    assertEquals((await state(fixture, seeded)).run.status, "canceled");
    assertEquals((await waitRow(fixture, seeded)).status, "canceled");
    assertEquals(
      await seeded.repository.completeWait(key, seeded.owner).catch(
        (error: Error) => error.message,
      ),
      "WORKFLOW_ENGINE_OWNER_LOST",
    );
    assertEquals((await waitRow(fixture, seeded)).status, "canceled");
  }));

// --- the engine function, driven with a fake step so the order of its
// durable steps is visible and a "crash" can happen at any one of them.

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

function engineFor(fixture: WorkerFixture): { handler: Handler } {
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
  });
  assert(captured.handler !== undefined);
  return { handler: captured.handler };
}

function recordingStep(
  record: string[],
  hooks: {
    sleep?: (id: string, ms: number) => Promise<void>;
    waitForEvent?: (id: string) => Promise<unknown>;
  } = {},
): FakeStep {
  return {
    run: async (id, work) => {
      record.push(id);
      return JSON.parse(JSON.stringify((await work()) ?? null));
    },
    sleep: async (id, duration) => {
      record.push(id);
      const ms = Number(/^(\d+)ms$/.exec(duration)?.[1]);
      assert(Number.isSafeInteger(ms), duration);
      await hooks.sleep?.(id, ms);
    },
    waitForEvent: (id) => {
      record.push(id);
      return hooks.waitForEvent?.(id) ?? Promise.reject(new Stop());
    },
    sendEvent: (id) => {
      record.push(id);
      return Promise.resolve();
    },
  };
}

const eventFor = (runId: string) => ({
  id: `e4a-${crypto.randomUUID()}`,
  data: { payload: { runId } },
});

const lease = async (fixture: WorkerFixture, seeded: Seeded) =>
  Number(
    (await fixture.pgDatabase.query<{ ms: string }>(
      `select floor(extract(epoch from (
              engine_owner_lease_expires_at - clock_timestamp())) * 1000)::text
            as ms
       from bakery.workflow_runs where id = $1`,
      [seeded.job.runId],
    )).rows[0].ms,
  );

Deno.test("the engine sleeps a wait with the lease stretched over it, records it elapsed and, the plan being done, completes the run", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded } = await atTheWait(fixture, shortPlan);
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);
    const record: string[] = [];
    const slept: number[] = [];
    let leaseDuringSleep = 0;
    let rearmedDuringSleep: unknown = "not asked";
    const step = recordingStep(record, {
      sleep: async (_id, ms) => {
        slept.push(ms);
        leaseDuringSleep = await lease(fixture, seeded);
        // A run asleep in a wait is not rearmed, however long the sleep.
        rearmedDuringSleep = await seeded.repository.rearmExpiredEngineOwners(
          50,
        );
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    assertEquals(
      await handler({ event: eventFor(seeded.job.runId), step }),
      { status: "completed" },
    );
    // One sleep for what was left (never more than the wait), the lease
    // covering it plus the engine's usual margin (twice the job completion
    // timeout, here two minutes), and nothing rearmed meanwhile.
    assertEquals(slept.length, 1);
    assert(slept[0] > 0 && slept[0] <= 1000, String(slept[0]));
    assert(
      leaseDuringSleep >= slept[0] + 120_000 - 5_000,
      `lease ${leaseDuringSleep} for a sleep of ${slept[0]}`,
    );
    assertEquals(rearmedDuringSleep, []);
    // The durable steps, in order: read, stretch, sleep, restore, complete,
    // then the plan is found finished and the run completes.
    const ids = record.filter((id) => /wait|complete/.test(id));
    assertEquals(ids[0], "read-wait-0");
    assertEquals(ids[1], "extend-engine-owner-for-wait-0");
    assertEquals(ids[2], "wait-for-duration-0-pause-0");
    assertEquals(ids[3], "renew-engine-owner-after-wait-0");
    assertEquals(ids[4], "complete-wait-0-pause-0");
    assert(record.includes("load-next-workflow-step-1"));
    assertEquals((await state(fixture, seeded)).run.status, "completed");
    const done = await waitRow(fixture, seeded);
    assertEquals(done.status, "completed");
    assertEquals(done.output, { outcome: "elapsed" });
    const all = await rows(fixture, seeded);
    assertEquals(all.map((row) => row.stepKey), [seeded.firstKey, "pause"]);
  }));

Deno.test("after a crash mid-sleep the next engine run sleeps only what is left, from the same start", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded } = await atTheWait(fixture, longPlan);
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);

    // First engine run: dies in the sleep.
    const firstSleeps: number[] = [];
    await assertRejects(
      () =>
        handler({
          event: eventFor(seeded.job.runId),
          step: recordingStep([], {
            sleep: (_id, ms) => {
              firstSleeps.push(ms);
              return Promise.reject(new Stop());
            },
          }),
        }),
      Stop,
    );
    assertEquals(firstSleeps.length, 1);
    // The process never released its owner: the lease is still stretched.
    await backdate(fixture, seeded, 600);
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set engine_owner_token = 'crashed',
              engine_owner_lease_expires_at = clock_timestamp()
              - interval '1 second',
              updated_at = clock_timestamp() - interval '5 seconds'
        where id = $1`,
      [seeded.job.runId],
    );
    assertEquals(
      (await seeded.repository.rearmExpiredEngineOwners(50)).map((run) =>
        run.runId
      ),
      [seeded.job.runId],
    );

    // Second engine run: sleeps the remainder, not the whole 30 seconds.
    const startBeforeSecondRun = (await waitRow(fixture, seeded)).startedAt;
    const secondSleeps: number[] = [];
    assertEquals(
      await handler({
        event: eventFor(seeded.job.runId),
        step: recordingStep([], {
          // Time passes by the database clock, not by waiting for it.
          sleep: async (_id, ms) => {
            secondSleeps.push(ms);
            await backdate(fixture, seeded, ms + 50);
          },
        }),
      }),
      { status: "completed" },
    );
    assertEquals(secondSleeps.length, 1);
    // Never more than what was left (the 30 s less the 600 ms that passed),
    // however long the host took between the two runs.
    assert(
      secondSleeps[0] > 0 && secondSleeps[0] <= 29_400,
      `slept ${secondSleeps[0]} after 600 of 30000 had passed`,
    );
    assertEquals((await waitRow(fixture, seeded)).status, "completed");
    // The engine never moved the start: the only change is the time the
    // sleep hook above let pass.
    const unmoved = await fixture.pgDatabase.query<{ ok: boolean }>(
      `select started_at = $2::timestamptz -
                ($3::integer * interval '1 millisecond') as ok
         from bakery.run_steps where run_id = $1 and step_key = 'pause'`,
      [seeded.job.runId, startBeforeSecondRun, secondSleeps[0] + 50],
    );
    assertEquals(unmoved.rows[0].ok, true);
  }));

Deno.test("a wait already past its time is completed without sleeping", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded } = await atTheWait(fixture, shortPlan);
    await backdate(fixture, seeded, 5000);
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);
    const record: string[] = [];
    assertEquals(
      await handler({
        event: eventFor(seeded.job.runId),
        step: recordingStep(record),
      }),
      { status: "completed" },
    );
    assertEquals(
      record.some((id) => id.startsWith("wait-for-duration")),
      false,
    );
    assertEquals(
      record.some((id) => id.startsWith("extend-engine-owner")),
      false,
    );
    assertEquals((await waitRow(fixture, seeded)).status, "completed");
  }));

Deno.test("a run canceled during the sleep ends there: the engine stands down and nothing after the wait is dispatched", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded } = await atTheWait(fixture);
    await seeded.repository.releaseEngineOwner(seeded.owner);
    const { handler } = engineFor(fixture);
    const step = recordingStep([], {
      sleep: async (_id, ms) => {
        await withPgTransaction(
          fixture.pgDatabase,
          (transaction) =>
            cancelRunWithoutAttempt(transaction, {
              organizationId: fixture.organizationId,
              runId: seeded.job.runId,
              traceId: crypto.randomUUID(),
            }),
        );
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    assertEquals(
      await handler({ event: eventFor(seeded.job.runId), step }),
      { status: "superseded" },
    );
    assertEquals((await state(fixture, seeded)).run.status, "canceled");
    assertEquals((await waitRow(fixture, seeded)).status, "canceled");
    assertEquals((await rows(fixture, seeded)).map((row) => row.stepKey), [
      seeded.firstKey,
      "pause",
    ]);
  }));
