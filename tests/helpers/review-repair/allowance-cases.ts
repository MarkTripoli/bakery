import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { allowMoreRepairTries } from "../../../apps/server/src/modules/delivery/repair-allowance.ts";
import { finding, fingerprintOf } from "./fixtures.ts";
import {
  HEADS,
  loopTest,
  type LoopWorld,
  withReviewedRun,
} from "./loop-world.ts";

// #62. A review and repair loop that ran out of tries can be allowed more, by a
// person, through the same engine: the allowance is recorded next to the frozen
// policy, the stop is answered with the repair it buys, the repeat's bound is
// raised by it, and the run the engine ended is asked again. Each case drives a
// real plan run through the production engine and the real worker result route.

const PLAN = { repairs: 2 } as const;

async function accept(
  turn: { post(result: unknown): Promise<Response> },
  report: unknown,
) {
  const response = await turn.post(report);
  assertEquals(response.status, 200, await response.clone().text());
}

/** A blocker with its own fingerprint, so no round repeats the one before. */
const blocker = (n: number) =>
  finding({
    fingerprint: fingerprintOf(n),
    severity: "blocker",
    path: "src/upload.ts",
    line: 10 + n,
  });

/** Runs the loop until the third review stops it: two repairs used, a blocker left. */
async function runOutOfTries(world: LoopWorld): Promise<void> {
  const first = await world.review(0);
  await accept(first, first.report([blocker(1)]));
  await world.repair(1, HEADS[1]);
  await world.check(1, HEADS[1]);
  const second = await world.review(1);
  await accept(second, second.report([blocker(2)]));
  await world.repair(2, HEADS[2]);
  await world.check(2, HEADS[2]);
  const third = await world.review(2);
  await accept(third, third.report([blocker(3)]));
  assertEquals(await world.runStatus(), "failed");
}

function allow(world: LoopWorld, tries: number, requestId = "allow-1") {
  return withPgTransaction(
    world.fixture.pgDatabase,
    (transaction) =>
      allowMoreRepairTries(transaction, {
        organizationId: world.fixture.organizationId,
        principalId: world.fixture.principalId,
        runId: world.runId,
        tries,
        requestId,
        traceId: "allow-trace",
      }),
  );
}

async function conflictReason(promise: Promise<unknown>): Promise<unknown> {
  const error = await assertRejects(() => promise, StandardError);
  assertEquals(error.code, "STATE_CONFLICT");
  return (error.params as { reason?: unknown } | undefined)?.reason;
}

export function registerAllowanceCases(): void {
  loopTest(
    "allowing one more try reopens the stopped run, which repairs once more and finishes clean",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        assertEquals(
          (await world.decisions()).map((d) => [d.ordinal, d.reason]),
          [
            [0, "repair_selected"],
            [1, "repair_selected"],
            [2, "repair_cycles_exhausted"],
          ],
        );

        const allowance = await allow(world, 1);
        assertEquals(allowance.addedTries, 1);
        assertEquals(allowance.maxRepairCycles, 3);
        assertEquals(allowance.answersDecisionOrdinal, 2);
        assertEquals(allowance.requestedBy, world.fixture.principalId);

        // The stop is answered with the repair it buys; the stop stays on record.
        assertEquals(
          (await world.decisions()).map((d) => [d.ordinal, d.decision]),
          [
            [0, "repair"],
            [1, "repair"],
            [2, "stop"],
            [3, "repair"],
          ],
        );
        assertEquals(await world.runStatus(), "queued");
        assertEquals(await world.taskStatus(), "queued");
        assertEquals((await world.audits("runs.reopen")).length, 1);
        assertEquals(
          (await world.audits("runRepairAllowances.create")).length,
          1,
        );

        // The engine asks the pinned plan again: a third repair is next.
        await world.resumeEngine();
        assertEquals(await world.nextKey(), "repair@3.repair_implement");
        await world.repair(3, HEADS[3]);
        await world.check(3, HEADS[3]);
        const fourth = await world.review(3);
        await accept(fourth, fourth.report([]));
        assertEquals(await world.nextKey(), undefined);
        assertEquals(await world.runStatus(), "completed");
        assertEquals(
          (await world.decisions()).map((d) => d.decision).at(-1),
          "proceed",
        );
      }, { plan: PLAN }),
  );

  loopTest(
    "the bound allowed is the bound held: a fourth repair still ends the loop at the raised limit",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        await allow(world, 1);
        await world.resumeEngine();
        await world.nextKey();
        await world.repair(3, HEADS[3]);
        await world.check(3, HEADS[3]);
        const fourth = await world.review(3);
        await accept(fourth, fourth.report([blocker(4)]));
        // Three repairs are used and three are allowed: the loop stops again.
        assertEquals(
          (await world.decisions()).at(-1)?.reason,
          "repair_cycles_exhausted",
        );
        assertEquals(await world.runStatus(), "failed");
      }, { plan: PLAN }),
  );

  loopTest(
    "allowing the same stop twice records one allowance and reopens once",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        const first = await allow(world, 1, "allow-1");
        const second = await allow(world, 1, "allow-2");
        assertEquals(second.id, first.id);
        assertEquals((await world.audits("runs.reopen")).length, 1);
        assertEquals(
          (await world.audits("runRepairAllowances.create")).length,
          1,
        );
        assertEquals((await world.decisions()).length, 4);
        assertEquals(await world.runStatus(), "queued");
      }, { plan: PLAN }),
  );

  loopTest(
    "a run that stopped for any other reason cannot be reopened this way",
    () =>
      withReviewedRun(async (world) => {
        // The same blocker twice is a repeated blocker, not a lack of tries.
        const first = await world.review(0);
        await accept(first, first.report([blocker(1)]));
        await world.repair(1, HEADS[1]);
        await world.check(1, HEADS[1]);
        const second = await world.review(1);
        await accept(second, second.report([blocker(1)]));
        assertEquals(await world.runStatus(), "failed");
        assertEquals(
          (await world.decisions()).at(-1)?.reason,
          "repeated_blocker",
        );
        assertEquals(
          await conflictReason(allow(world, 1)),
          "repair_not_exhausted",
        );
        assertEquals(await world.runStatus(), "failed");
        assertEquals((await world.audits("runs.reopen")).length, 0);
      }, { plan: PLAN }),
  );

  loopTest(
    "a run that ran out of tries but was ended some other way cannot be reopened",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        await world.fixture.pgDatabase.query(
          `update bakery.workflow_runs set status = 'canceled'
            where organization_id = $1 and id = $2`,
          [world.fixture.organizationId, world.runId],
        );
        assertEquals(
          await conflictReason(allow(world, 1)),
          "run_not_stopped_by_loop",
        );
        assertEquals((await world.audits("runs.reopen")).length, 0);
        assertEquals((await world.decisions()).length, 3);
      }, { plan: PLAN }),
  );

  loopTest(
    "more tries than the workflow can ever hold are refused and nothing is written",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        // Two are allowed by the plan; eight is the most any workflow holds.
        assertEquals(
          await conflictReason(allow(world, 7)),
          "allowance_exceeds_workflow_maximum",
        );
        const error = await assertRejects(() => allow(world, 0), StandardError);
        assertEquals(error.code, "UNPROCESSABLE");
        assertEquals((await world.decisions()).length, 3);
        assertEquals(await world.runStatus(), "failed");
        const largest = await allow(world, 6);
        assertEquals(largest.maxRepairCycles, 8);
        assert(largest.id.length > 0);
      }, { plan: PLAN }),
  );
}
