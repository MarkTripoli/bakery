import { assert, assertEquals, assertRejects } from "@std/assert";
import { rows, seedPlanRun, setRow } from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { compiled, noop, stop } from "../helpers/workflow-interpreter.ts";

// #411's remaining piece. `workflow.stop` is a step type an author can publish
// and the registry knows, but nothing dispatched it: `stopRun` was a tested
// writer with no producer, and wiring it into cancel would have overwritten
// `canceled` with `succeeded`. These tests hold the producer in place, and what
// they assert is the *stored* outcome, because "the run ended" is true of a
// crash as well and says nothing about what it ended as.

const namedPlan = (outcome: string, reason?: string) =>
  compiled([
    noop("first"),
    stop("end", { outcome, ...(reason === undefined ? {} : { reason }) }, {
      needs: ["first"],
    }),
    noop("never", { needs: ["end"] }),
  ]);

/** The plan with its first step done, so the stop is the next dispatch. */
async function atTheStop(
  fixture: WorkerFixture,
  makePlan: () => Promise<Awaited<ReturnType<typeof compiled>>>,
) {
  const seeded = await seedPlanRun(fixture, await makePlan());
  await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 1 });
  return seeded;
}

const runRow = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<{
    status: string;
    outcome: string | null;
    outcomeReason: string | null;
    finishedAt: string | null;
  }>(
    `select status, outcome, outcome_reason as "outcomeReason",
            finished_at::text as "finishedAt"
       from bakery.workflow_runs where id = $1`,
    [runId],
  )).rows[0];

const stopStep = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<{ status: string; output: unknown }>(
    `select status, output from bakery.run_steps
      where run_id = $1 and step_key = 'end'`,
    [runId],
  )).rows[0];

const ledger = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<{ kind: string; reason: string | null }>(
    `select kind, reason from bakery.decisions_ledger
      where run_id = $1 and kind = 'stop'`,
    [runId],
  )).rows;

Deno.test("a workflow.stop step ends the run with the outcome it named", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheStop(
      fixture,
      () => namedPlan("nothing_to_do", "The repository had no open issues."),
    );

    // The stop is the next thing the engine dispatches: before this existed the
    // step was simply skipped and the run ran on to the step after it.
    const key = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assert(key !== undefined, "the stop step is dispatched");
    assertEquals(key.stepKey, "end");

    // Driving the dispatch is the producer: the step settles and the run ends
    // with the named outcome in one transaction.
    // `admit` is the path the engine drives for every dispatched step; a stop
    // is settled there rather than handed to a worker, so this is the producer
    // exercised end to end.
    const settled = await seeded.repository.admit(key, seeded.owner).then(
      () => "stopped",
    );
    assertEquals(settled, "stopped");

    const run = await runRow(fixture, seeded.job.runId);
    assertEquals(run.status, "canceled");
    assertEquals(run.outcome, "nothing_to_do");
    assertEquals(run.outcomeReason, "The repository had no open issues.");
    assert(run.finishedAt !== null, "the run records when it ended");

    // The step itself is completed with the normalized outcome, so a reader of
    // the step row sees the same name the run carries.
    const step = await stopStep(fixture, seeded.job.runId);
    assertEquals(step.status, "completed");
    assertEquals((step.output as { outcome: string }).outcome, "nothing_to_do");

    // And the ledger records the decision, because a run that ends on purpose
    // has to say why to the person reading it later.
    const stops = await ledger(fixture, seeded.job.runId);
    assertEquals(stops.length, 1);
    assertEquals(stops[0].reason, "The repository had no open issues.");

    // The step after the stop never ran: a stop ends the run, it does not
    // divert it.
    const after = await rows(fixture, seeded);
    assert(
      !after.some((row) => row.stepKey === "never"),
      "no step after a stop is dispatched",
    );
  }));

Deno.test("a workflow.stop step that names no outcome still ends the run", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheStop(fixture, () =>
      compiled([
        noop("first"),
        stop("end", {}, { needs: ["first"] }),
      ]));

    const key = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assert(key !== undefined);
    await seeded.repository.admit(key, seeded.owner);

    // Asking for an explicit name where the reason already explains the ending
    // buys nothing, so the neutral name is applied rather than the step being
    // refused for a missing field.
    const run = await runRow(fixture, seeded.job.runId);
    assertEquals(run.outcome, "stopped");
    assertEquals(run.status, "canceled");
  }));

Deno.test("a stop and a rejection end a run with different names", () =>
  withWorkerFixture(async (fixture) => {
    // The reason a person needs is the difference between "somebody decided no"
    // and "the workflow decided there was nothing to do". A single generic
    // "stopped" for both would throw that away, so the two names are asserted
    // side by side rather than each against a constant.
    const stopped = await atTheStop(fixture, () => namedPlan("nothing_to_do"));
    const stopKey = await stopped.repository.findNext(
      stopped.job.runId,
      stopped.owner,
    );
    assert(stopKey !== undefined);
    await stopped.repository.admit(stopKey, stopped.owner);

    const rejected = await atTheStop(
      fixture,
      () => namedPlan("rejected", "The approver rejected the change."),
    );
    const rejectKey = await rejected.repository.findNext(
      rejected.job.runId,
      rejected.owner,
    );
    assert(rejectKey !== undefined);
    await rejected.repository.admit(rejectKey, rejected.owner);

    const a = await runRow(fixture, stopped.job.runId);
    const b = await runRow(fixture, rejected.job.runId);
    assertEquals(a.outcome, "nothing_to_do");
    assertEquals(b.outcome, "rejected");
    assert(
      a.outcome !== b.outcome,
      "a stop and a rejection must not share one outcome name",
    );
  }));

Deno.test("settling a stop twice records the ledger entry once", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheStop(
      fixture,
      () => namedPlan("nothing_to_do", "Nothing to do."),
    );
    const key = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assert(key !== undefined);

    await seeded.repository.admit(key, seeded.owner);
    // The engine polls, and a replay after a crash finds the step already
    // settled. That must not append a second decision or a second event: the
    // ledger is the record of what was decided, not of how often the engine
    // asked. The replay is refused at the engine-owner fence, which requires a
    // run that has not ended, so a second stop can never reach a write.
    await assertRejects(
      () => seeded.repository.admit(key, seeded.owner),
      Error,
      "WORKFLOW_ENGINE_OWNER_LOST",
    );

    assertEquals((await ledger(fixture, seeded.job.runId)).length, 1);
    const events = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.domain_events
        where aggregate_id = $1 and event_type = 'workflow.stopped'`,
      [seeded.job.runId],
    );
    assertEquals(events.rows[0].count, "1");
  }));

Deno.test("a stop refuses a run that has already ended", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheStop(fixture, () => namedPlan("nothing_to_do"));
    const key = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assert(key !== undefined);
    await seeded.repository.admit(key, seeded.owner);

    // Once the run has ended, a second stop is not another ending. It answers
    // with the state it found rather than overwriting the first outcome, which
    // is the defect that stopped `stopRun` being wired into cancel: a canceled
    // run would have been relabelled succeeded.
    // A second admit is refused at the engine-owner fence, which requires a run
    // that has not ended. That is the check that a stop cannot relabel a
    // canceled run: it never reaches an owner that could write.
    await assertRejects(
      () => seeded.repository.admit(key, seeded.owner),
      Error,
      "WORKFLOW_ENGINE_OWNER_LOST",
    );
    assertEquals(
      (await runRow(fixture, seeded.job.runId)).outcome,
      "nothing_to_do",
    );
  }));
