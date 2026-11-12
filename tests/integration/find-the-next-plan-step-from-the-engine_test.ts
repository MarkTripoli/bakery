import { assert, assertEquals, assertRejects } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { pinWorkflowRuntime } from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import { seedFundedModelJob } from "../helpers/funded-model-job.ts";
import {
  audit,
  rows,
  seedPlanRun,
  setRow,
  state,
} from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";

// #30 E3b-2a. For a compiled-plan run the engine's findNext asks the run's own
// interpreter revision, appends the next step row on demand, and ends the run
// when the plan is finished or halted. The funded fixture gives a run with one
// open row; the plan is shaped so that row is the plan's first dispatch.

const chain = () =>
  compiled([
    noop("first"),
    noop("second", { needs: ["first"], with: { carried: "$step.first.n" } }),
  ]);

const repeating = () =>
  compiled([{
    id: "loop",
    repeat: {
      max: 3,
      seed: { currentCandidate: { n: 0 } },
      until: "$repeat.currentCandidate.n >= 2",
      steps: [noop("bump", { with: { n: "$repeat.currentCandidate.n" } })],
      outputs: { currentCandidate: { n: "$step.loop.bump.next" } },
    },
  }, noop("report", { with: { outcome: "$step.loop.outcome" } })]);

Deno.test("the first dispatch finds its row and returns its key, again and again", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await chain());
    const key = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assertEquals(key, {
      runId: seeded.job.runId,
      stepKey: seeded.firstKey,
      iteration: 0,
      actionVersion: seeded.versionId,
    });
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, seeded.owner),
      key,
    );
    assertEquals((await rows(fixture, seeded)).length, 1);
    assertEquals((await state(fixture, seeded)).run.status, "running");
  }));

Deno.test("when a step completes the next row is appended on demand with the resolved input", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await chain());
    await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 7 });
    const key = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assertEquals(key?.stepKey, "second");
    assertEquals(key?.iteration, 0);
    const after = await rows(fixture, seeded);
    assertEquals(after.map((row) => [row.stepKey, row.status]), [
      [seeded.firstKey, "completed"],
      ["second", "pending"],
    ]);
    assert(after[1].position > after[0].position);
    assertEquals((after[1].input as { carried: number }).carried, 7);
    // A replay finds the same row instead of appending another.
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, seeded.owner),
      key,
    );
    assertEquals((await rows(fixture, seeded)).length, 2);
  }));

Deno.test("the plan reads $task from the run's frozen snapshot, not from the live task", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(
      fixture,
      await compiled([
        noop("first"),
        noop("second", { needs: ["first"], with: { title: "$task.title" } }),
      ]),
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = jsonb_set(snapshot, '{task}', '{"title":"frozen title"}'::jsonb)
        where id = $1`,
      [seeded.job.runId],
    );
    await fixture.pgDatabase.query(
      `update bakery.tasks set title = 'edited after the run started' where id = $1`,
      [seeded.job.taskId],
    );
    await setRow(fixture, seeded, seeded.firstKey, "completed", {});
    await seeded.repository.findNext(seeded.job.runId, seeded.owner);
    const second = (await rows(fixture, seeded)).find((row) =>
      row.stepKey === "second"
    );
    assertEquals(second?.input, { title: "frozen title" });
  }));

Deno.test("a finished plan ends the run and its task as completed and returns no key", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await chain());
    await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 1 });
    await seeded.repository.findNext(seeded.job.runId, seeded.owner);
    await setRow(fixture, seeded, "second", "completed", {});
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, seeded.owner),
      undefined,
    );
    const end = await state(fixture, seeded);
    assertEquals(end.run.status, "completed");
    assert(end.run.finishedAt !== null);
    assertEquals(end.run.owner, null);
    assertEquals(end.task.status, "completed");
  }));

Deno.test("a step that fails outside a repeat halts the plan: the run and its task fail", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await chain());
    await setRow(fixture, seeded, seeded.firstKey, "failed");
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, seeded.owner),
      undefined,
    );
    const end = await state(fixture, seeded);
    assertEquals(end.run.status, "failed");
    assertEquals(end.task.status, "failed");
  }));

Deno.test("a failed repeat iteration is an outcome, not the end of the run", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await repeating());
    await setRow(fixture, seeded, seeded.firstKey, "failed");
    const key = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assert(key !== undefined, "the plan goes on");
    assert(key.stepKey !== seeded.firstKey);
    assertEquals((await state(fixture, seeded)).run.status, "running");
    assertEquals((await rows(fixture, seeded)).length, 2);
  }));

Deno.test("a wait is not run yet: the run fails with a stable code in the audit log", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(
      fixture,
      await compiled([{ id: "pause", wait: { duration: "5m" } }]),
    );
    // The seeded row is renamed to the wait's key; the wait is still the dispatch.
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, seeded.owner),
      undefined,
    );
    assertEquals((await state(fixture, seeded)).run.status, "failed");
    assertEquals(await audit(fixture, seeded), ["plan_wait_unsupported"]);
  }));

Deno.test("a plan that cannot be read fails the run with the interpreter's code, not a hang", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await chain());
    // The run's pin now names another document: the revision is deployed but
    // the frozen document no longer matches it.
    const pin = await pinWorkflowRuntime(await compiled([noop("elsewhere")]));
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = jsonb_set(snapshot, '{runtime,pin}', $2::jsonb)
        where id = $1`,
      [seeded.job.runId, JSON.stringify(pin)],
    );
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, seeded.owner),
      undefined,
    );
    assertEquals((await state(fixture, seeded)).run.status, "failed");
    assertEquals((await state(fixture, seeded)).task.status, "failed");
    assertEquals(await audit(fixture, seeded), ["pin_mismatch"]);
  }));

Deno.test("a plan run needs the engine owner to be asked", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await chain());
    await assertRejects(
      () => seeded.repository.findNext(seeded.job.runId, undefined),
      Error,
      "WORKFLOW_ENGINE_OWNER_LOST",
    );
    await assertRejects(
      () =>
        seeded.repository.findNext(seeded.job.runId, {
          ...seeded.owner,
          token: "someone-else",
        }),
      Error,
      "WORKFLOW_ENGINE_OWNER_LOST",
    );
    assertEquals((await rows(fixture, seeded)).length, 1);
  }));

Deno.test("a run that is no longer open has no next step, and its old owner is refused", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await chain());
    await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 1 });
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set status = 'canceled', finished_at = now() where id = $1`,
      [seeded.job.runId],
    );
    // The ownership fence ends with the run, as it does for a flat run.
    await assertRejects(
      () => seeded.repository.findNext(seeded.job.runId, seeded.owner),
      Error,
      "WORKFLOW_ENGINE_OWNER_LOST",
    );
    // Asked without a fence (a read for recovery), there is simply no next step.
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, undefined),
      undefined,
    );
    assertEquals((await rows(fixture, seeded)).length, 1);
  }));

Deno.test("an engine failure between plan steps ends the run, by owner object and by token", () =>
  withWorkerFixture(async (fixture) => {
    for (const byToken of [false, true]) {
      const seeded = await seedPlanRun(fixture, await chain());
      await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 1 });
      await setRow(fixture, seeded, "second", "completed", {});
      // No open row is left: a flat run would find nothing to fail.
      await seeded.repository.markEngineFailure(
        seeded.job.runId,
        "ATTEMPT_BUDGET_EXHAUSTED:no attempts left",
        byToken ? seeded.owner.token : seeded.owner,
      );
      assertEquals((await state(fixture, seeded)).run.status, "failed");
      assertEquals((await state(fixture, seeded)).task.status, "failed");
      assertEquals(await audit(fixture, seeded), ["ATTEMPT_BUDGET_EXHAUSTED"]);
    }
  }));

Deno.test("a flat run is still served by the row-order loop", () =>
  withWorkerFixture(async (fixture) => {
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const repository = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 3,
    });
    const owner = await repository.acquireEngineOwner(
      job.runId,
      `e3b2a-${crypto.randomUUID()}`,
      60_000,
    );
    assert(owner !== undefined);
    const key = await repository.findNext(job.runId, owner);
    assertEquals(key?.runId, job.runId);
    assertEquals(key?.iteration, 0);
  }));
