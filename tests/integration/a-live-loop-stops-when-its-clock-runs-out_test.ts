import { assert, assertEquals } from "@std/assert";
import { REVIEW_LOOP_LIMITS } from "../../packages/contracts/src/review-evidence.ts";
import { finding, fingerprintOf } from "../helpers/review-repair/fixtures.ts";
import {
  HEADS,
  loopFixtureCloseStep,
  loopTest,
  shareLoopFixture,
  withReviewedRun,
} from "../helpers/review-repair/loop-world.ts";

shareLoopFixture();

const blocker = (n = 1) =>
  finding({
    fingerprint: fingerprintOf(n),
    severity: "blocker",
    path: "src/upload.ts",
    line: 12,
  });

async function accept(
  turn: { post(result: unknown): Promise<Response> },
  report: unknown,
) {
  const response = await turn.post(report);
  assertEquals(response.status, 200, await response.clone().text());
}

loopTest(
  "a live loop stops on the clock, and the decision row carries the limit it hit",
  async () => {
    await withReviewedRun(async (world) => {
      const first = await world.review(0);
      await accept(first, first.report([blocker()]));
      const [opened] = await world.decisions();
      assertEquals(opened.reason, "repair_selected");

      await world.repair(1, HEADS[1]);
      await world.check(1, HEADS[1], {});

      await world.fixture.pgDatabase.query(
        `update bakery.review_cycles
            set created_at = created_at - interval '26 hours'
          where organization_id = $1 and run_id = $2`,
        [world.fixture.organizationId, world.runId],
      );

      const second = await world.review(1);
      await accept(second, second.report([blocker(2)]));

      const decisions = await world.decisions();
      const stopped = decisions[decisions.length - 1];
      assert(stopped, "the second review recorded a decision");
      assertEquals([stopped.decision, stopped.reason], [
        "stop",
        "repair_time_exhausted",
      ]);
      assertEquals(stopped.head_sha, HEADS[1]);
      assertEquals(
        stopped.limits.maxLoopDurationMs,
        REVIEW_LOOP_LIMITS.maxLoopDurationMs,
      );
      assertEquals(
        await world.evidenceCounts().then((counts) => counts.cycles),
        2,
      );
    });
  },
);

loopTest(
  "a plan that names a shorter clock stops its live loop at that bound",
  async () => {
    await withReviewedRun(async (world) => {
      const first = await world.review(0);
      await accept(first, first.report([blocker()]));

      await world.repair(1, HEADS[1]);
      await world.check(1, HEADS[1], {});
      await world.fixture.pgDatabase.query(
        `update bakery.review_cycles
            set created_at = created_at - interval '23 hours 30 minutes'
          where organization_id = $1 and run_id = $2`,
        [world.fixture.organizationId, world.runId],
      );

      const second = await world.review(1);
      await accept(second, second.report([blocker(2)]));

      const decisions = await world.decisions();
      const stopped = decisions[decisions.length - 1];
      assertEquals([stopped.decision, stopped.reason], [
        "stop",
        "repair_time_exhausted",
      ]);
      assertEquals(stopped.limits.maxLoopDurationMs, 23 * 60 * 60 * 1000);
    }, { plan: { repairs: 2, limits: { wallClock: "23h" } } });
  },
);

loopFixtureCloseStep("a loop that ran out of clock");

loopTest(
  "a run's budget is the plan's ceiling when the requester asks for more",
  async () => {
    await withReviewedRun(async (world) => {
      const { rows } = await world.fixture.pgDatabase.query<
        { budget_limit_usd: string }
      >(
        `select budget_limit_usd from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [world.fixture.organizationId, world.runId],
      );
      assertEquals(rows[0].budget_limit_usd, "10.000000");
    }, {
      budgetLimitUsd: "12.00",
      plan: { repairs: 2, limits: { maxCostUsd: 10 } },
    });
  },
);

loopTest(
  "a run naming no budget takes the ceiling, still inside the per-run cap",
  async () => {
    await withReviewedRun(async (world) => {
      const { rows } = await world.fixture.pgDatabase.query<
        { budget_limit_usd: string }
      >(
        `select budget_limit_usd from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [world.fixture.organizationId, world.runId],
      );
      assertEquals(rows[0].budget_limit_usd, "200.000000");
    }, {
      budgetLimitUsd: null,
      plan: { repairs: 2, limits: { maxCostUsd: 500 } },
    });
  },
);
