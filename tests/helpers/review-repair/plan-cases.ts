import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  REVIEW_RECORD_OPERATION,
} from "../../../apps/server/src/modules/delivery/index.ts";
import { PLAN_DELIVERY_STOPPED_CODE } from "../../../apps/server/src/modules/delivery/plan-host.ts";
import { finding, fingerprintOf } from "./fixtures.ts";
import {
  HEADS,
  loopTest,
  type LoopWorld,
  withReviewedRun,
} from "./loop-world.ts";

// #397. The review and repair loop on a compiled plan: the same verification,
// the same evidence rows and the same decisions as a flat run, with the plan's
// own `repeat` running each repair and its recorded stop halting the run. Each
// case drives a real plan run through the production engine and the real
// worker result route, then reads back what the tables hold.

const PLAN = { repairs: 2 } as const;

const keys = (steps: Array<{ step_key: string; iteration: number }>) =>
  steps.map((step) => `${step.step_key}@${step.iteration}`);

async function accept(
  turn: { post(result: unknown): Promise<Response> },
  report: unknown,
) {
  const response = await turn.post(report);
  assertEquals(response.status, 200, await response.clone().text());
}

const blocker = (line = 12) =>
  finding({
    fingerprint: fingerprintOf(1),
    severity: "blocker",
    path: "src/upload.ts",
    line,
  });

/** What a gate-failed audit of the engine says, for the run. */
async function planFailures(world: LoopWorld): Promise<string[]> {
  const rows = await world.fixture.pgDatabase.query<{ code: string }>(
    `select details ->> 'code' as code from bakery.audit_events
      where organization_id = $1 and operation = 'workflow.plan_failed'
        and resource_id = $2 order by created_at, id`,
    [world.fixture.organizationId, world.runId],
  );
  return rows.rows.map(({ code }) => code);
}

export function registerPlanCases(): void {
  loopTest(
    "a clean review of a plan run records its cycle and decision, appends nothing, and the plan finishes",
    () =>
      withReviewedRun(async (world) => {
        const before = keys(await world.steps());
        assertEquals(before, [
          "brief@0",
          "implement@0",
          "check@0",
        ]);
        const review = await world.review(0);
        const report = review.report([]);
        await accept(review, report);

        const cycles = await world.cycles();
        assertEquals(cycles.length, 1);
        assertEquals(cycles[0].id, report.reviewId);
        assertEquals(cycles[0].ordinal, 0);
        assertEquals(cycles[0].status, "approved");
        assertEquals(cycles[0].head_sha, HEADS[0]);
        assertEquals(cycles[0].reviewer_session_id, review.sessionId);
        assertNotEquals(
          cycles[0].implementer_session_id,
          cycles[0].reviewer_session_id,
        );
        const decisions = await world.decisions();
        assertEquals(decisions.map((d) => [d.decision, d.reason]), [
          ["proceed", "clean"],
        ]);
        // The decision added no row; the review row is the plan's own.
        assertEquals(keys(await world.steps()), [...before, "review@0"]);
        // The seed candidate is clean, so the repeat never runs and the plan is over.
        assertEquals(await world.nextKey(), undefined);
        assertEquals(await world.runStatus(), "completed");
        assertEquals(
          (await world.audits(REVIEW_RECORD_OPERATION, "succeeded")).length,
          1,
        );
      }, { plan: PLAN }),
  );

  loopTest(
    "a blocking review of a plan run records a repair decision and appends no step: the plan's repeat runs the repair with $delivery resolved",
    () =>
      withReviewedRun(async (world) => {
        const review = await world.review(0);
        await accept(review, review.report([blocker()]));

        const decisions = await world.decisions();
        assertEquals(decisions.map((d) => [d.decision, d.reason]), [
          ["repair", "blocking_findings"],
        ]);
        assertEquals(decisions[0].blocking_fingerprints, [fingerprintOf(1)]);
        // The finalizer appended nothing: only the plan's own rows exist, and
        // every one of them is stored at iteration 0.
        const steps = await world.steps();
        assertEquals(keys(steps), [
          "brief@0",
          "implement@0",
          "check@0",
          "review@0",
        ]);
        // The plan asks for the repair itself, over the evidence $delivery names.
        assertEquals(await world.nextKey(), "repair@1.repair_implement");
        const input = await world.dispatchInput("repair@1.repair_implement");
        assertEquals(input.revision, HEADS[0]);
        assertEquals(input.failedChecks, []);
        const findings = input.findings as Array<Record<string, unknown>>;
        assertEquals(findings.map((f) => f.fingerprint), [fingerprintOf(1)]);
        assertEquals(findings[0].blocking, true);
      }, { plan: PLAN }),
  );

  loopTest(
    "a plan run repairs, reviews the new candidate, and a clean second review proceeds",
    () =>
      withReviewedRun(async (world) => {
        const first = await world.review(0);
        await accept(first, first.report([blocker()]));
        await world.repair(1, HEADS[1]);
        await world.check(1, HEADS[1]);
        const second = await world.review(1);
        assertEquals(second.pins.headSha, HEADS[1]);
        await accept(second, second.report([]));

        const cycles = await world.cycles();
        assertEquals(cycles.map((c) => [c.ordinal, c.status, c.head_sha]), [
          [0, "changes_requested", HEADS[0]],
          [1, "approved", HEADS[1]],
        ]);
        assertEquals(
          (await world.decisions()).map((d) => [d.ordinal, d.decision]),
          [[0, "repair"], [1, "proceed"]],
        );
        // Four rows of repair round 1 are the plan's own; none came from the loop.
        assertEquals(keys(await world.steps()), [
          "brief@0",
          "implement@0",
          "check@0",
          "review@0",
          "repair@1.repair_implement@0",
          "repair@1.repair_check@0",
          "repair@1.repair_review@0",
        ]);
      }, { plan: PLAN }),
  );

  loopTest(
    "a blocker that survives its repair records a stop and the engine halts the plan run with no delivery_gate row",
    () =>
      withReviewedRun(async (world) => {
        const first = await world.review(0);
        await accept(first, first.report([blocker(12)]));
        await world.repair(1, HEADS[1]);
        await world.check(1, HEADS[1]);
        const second = await world.review(1);
        await accept(second, second.report([blocker(40)]));

        const decisions = await world.decisions();
        assertEquals(decisions.map((d) => [d.decision, d.reason]), [
          ["repair", "blocking_findings"],
          ["stop", "repeated_blocker"],
        ]);
        // The plan would run a third round (repeat max 3); the recorded stop ends it.
        assertEquals(await world.nextKey(), undefined);
        assertEquals(await world.runStatus(), "failed");
        assertEquals(await planFailures(world), [PLAN_DELIVERY_STOPPED_CODE]);
        const steps = await world.steps();
        assert(
          !steps.some((step) => step.step_key === "delivery_gate"),
          "a plan run gets no delivery_gate row",
        );
        assertEquals(steps.every((step) => step.iteration === 0), true);
      }, { plan: { repairs: 3 } }),
  );

  loopTest(
    "a review whose reviewer is the implementer's child session is refused and records nothing",
    () =>
      withReviewedRun(async (world) => {
        const review = await world.review(0);
        const implement = (await world.steps()).find((step) =>
          step.step_key === "implement"
        )!;
        const [implementer] = await world.sessionIds(implement.id);
        await world.fixture.pgDatabase.query(
          `update bakery.agent_sessions set parent_session_id = $3
            where organization_id = $1 and id = $2`,
          [world.fixture.organizationId, review.sessionId, implementer],
        );
        const response = await review.post(review.report([]));
        assertEquals(response.status, 422, await response.clone().text());
        assertEquals(await world.evidenceCounts(), {
          cycles: 0,
          findings: 0,
          decisions: 0,
        });
        const denied = await world.audits(REVIEW_RECORD_OPERATION, "denied");
        assertEquals(
          denied.map((entry) => entry.details.reason),
          ["review_not_independent"],
        );
      }, { plan: PLAN }),
  );

  loopTest(
    "a review of a head that is not the plan run's candidate is refused and records nothing",
    () =>
      withReviewedRun(async (world) => {
        const review = await world.review(0);
        const response = await review.post(
          review.report([], { headSha: HEADS[2] }),
        );
        assertEquals(response.status, 422, await response.clone().text());
        assertEquals(await world.evidenceCounts(), {
          cycles: 0,
          findings: 0,
          decisions: 0,
        });
        const denied = await world.audits(REVIEW_RECORD_OPERATION, "denied");
        assertEquals(
          denied.map((entry) => entry.details.reason),
          ["review_report_invalid"],
        );
      }, { plan: PLAN }),
  );

  loopTest(
    "a reviewer that fails for good stops a plan run: a stop decision with no cycle, and the run fails",
    () =>
      withReviewedRun(async (world) => {
        const review = await world.review(0);
        const response = await review.fail({
          code: "REVIEWER_UNAVAILABLE",
          retryable: false,
        });
        assertEquals(response.status, 200, await response.clone().text());
        const decisions = await world.decisions();
        assertEquals(decisions.map((d) => [d.decision, d.reason]), [
          ["stop", "reviewer_unavailable"],
        ]);
        assertEquals((await world.cycles()).length, 0);
        assertEquals(
          (await world.steps()).some((step) =>
            step.step_key === "delivery_gate"
          ),
          false,
        );
        assertEquals(await world.nextKey(), undefined);
        assertEquals(await world.runStatus(), "failed");
      }, { plan: PLAN }),
  );
}
