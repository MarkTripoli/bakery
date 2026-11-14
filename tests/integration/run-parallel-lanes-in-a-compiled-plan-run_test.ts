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

Deno.test("a new plan run is pinned to revision 2, and a group answers with one step per running lane, idempotently", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedRun(fixture, await plan());
    const pin = (await fixture.pgDatabase.query<
      { revision: string }
    >(
      `select snapshot #>> '{runtime,pin,interpreterRevision}' as revision
         from bakery.workflow_runs where id = $1`,
      [seeded.job.runId],
    )).rows[0].revision;
    assertEquals(pin, "2");

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
