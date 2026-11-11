import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  DELIVERY_GATE_STEP_KEY,
  DELIVERY_LOOP_STOPPED_CODE,
  REVIEW_LOOP_LIMITS,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  assertDeliveryCandidateMergeable,
  evaluateDeliveryCandidate,
  REVIEW_RECORD_OPERATION,
  REVIEW_STOP_OPERATION,
} from "../../../apps/server/src/modules/delivery/index.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { apiCall, expectJson } from "../fixed-coding-preset.ts";
import { insertCheckRun } from "../deterministic-checks/run-fixture.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { finding, fingerprintOf } from "./fixtures.ts";
import { HEADS, type LoopWorld, withReviewedRun } from "./loop-world.ts";

// Issue #94 (B10.03) Phase 4, integration lane: the review.independent result
// through the real worker route, the real finalizer and real Postgres. A run of
// the reviewed preset is created through runs.create; its implement, repair and
// review results are posted to the route a worker uses; the seed checks are the
// rows a quality.check finalizer writes. Each case reads back what the route
// left in the tables, the steps and the audit log.

const LIMITS = {
  maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCycles,
  maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
  maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
};

const stepKeys = (steps: Array<{ step_key: string; iteration: number }>) =>
  steps.map((step) => `${step.step_key}@${step.iteration}`);

/** The delivery gate, read with the application role like a merge consumer. */
function gate(world: LoopWorld) {
  return withPgTransaction(
    world.fixture.runtimePgDatabase,
    (transaction) =>
      evaluateDeliveryCandidate(transaction, {
        organizationId: world.fixture.organizationId,
        runId: world.runId,
      }),
  );
}

/** Posts an accepted review and asserts the route answered 200. */
async function accept(
  turn: { post(result: unknown): Promise<Response> },
  report: unknown,
) {
  const response = await turn.post(report);
  assertEquals(response.status, 200, await response.clone().text());
}

async function checkRunCount(world: LoopWorld): Promise<number> {
  const result = await world.fixture.pgDatabase.query<{ count: string }>(
    `select count(*)::text as count from bakery.check_runs
      where organization_id = $1 and run_id = $2`,
    [world.fixture.organizationId, world.runId],
  );
  return Number(result.rows[0].count);
}

export function registerLoopIntegrationCases(): void {
  registerCleanSeedCases();
  registerRepairCases();
  registerStopCases();
  registerReviewerFailureCases();
  registerGateCases();
  registerUnreadablePolicyGateCase();
  registerLoneSurrogateCase();
  registerHttpReadCases();
}

function registerCleanSeedCases(): void {
  Deno.test("a clean seed candidate is proceeded with zero repairs and the seed evidence is kept (AC2)", () =>
    withReviewedRun(async (world) => {
      const before = await world.steps();
      assertEquals(stepKeys(before), [
        "brief@0",
        "implement@0",
        "check@0",
        "review@0",
      ]);
      const seedChecks = await checkRunCount(world);
      assertEquals(seedChecks, 2);

      const review = await world.review(0);
      const report = review.report([]);
      await accept(review, report);

      // Zero rows appended: the loop's shape is the seed's, all completed.
      const after = await world.steps();
      assertEquals(stepKeys(after), stepKeys(before));
      assertEquals(
        new Set(after.map((step) => step.status)),
        new Set(["completed"]),
      );
      assertEquals(await checkRunCount(world), seedChecks);

      // One approved cycle with exact provenance.
      const cycles = await world.cycles();
      assertEquals(cycles.length, 1);
      const [cycle] = cycles;
      assertEquals(cycle.id, report.reviewId);
      assertEquals(cycle.ordinal, 0);
      assertEquals(cycle.status, "approved");
      assertEquals(cycle.head_sha, HEADS[0]);
      assertEquals(cycle.base_sha, review.pins.baseSha);
      assertEquals(cycle.policy_digest, review.pins.policyDigest);
      assertEquals(cycle.reviewer_session_id, review.sessionId);
      assertEquals(cycle.run_step_id, review.stepId);
      assertEquals(cycle.job_id, review.jobId);
      assertEquals(cycle.attempt_id, review.attemptId);
      assertEquals(cycle.fence, review.assignment.fence);
      assertEquals(cycle.finding_count, 0);
      assertEquals(cycle.blocking_count, 0);
      // The implementer is the session of the step that produced the head,
      // never the reviewer's, and both principals are the hosts' own.
      const implementSessions = await world.sessionIds(
        before.find((step) => step.step_key === "implement")!.id,
      );
      assertEquals(cycle.implementer_session_id, implementSessions[0]);
      assertNotEquals(cycle.implementer_session_id, cycle.reviewer_session_id);
      const reviewerHost = await world.fixture.pgDatabase.query<
        { principal_id: string }
      >(
        "select principal_id from bakery.worker_hosts where id = $1",
        [review.worker.registration.workerHostId],
      );
      assertEquals(
        cycle.reviewer_principal_id,
        reviewerHost.rows[0].principal_id,
      );

      // One proceed decision at ordinal 0 that carries no failed check.
      const decisions = await world.decisions();
      assertEquals(decisions.length, 1);
      assertEquals(decisions[0].ordinal, 0);
      assertEquals(decisions[0].decision, "proceed");
      assertEquals(decisions[0].reason, "clean");
      assertEquals(decisions[0].review_cycle_id, cycle.id);
      assertEquals(decisions[0].head_sha, HEADS[0]);
      assertEquals(decisions[0].failed_checks, []);
      assertEquals(decisions[0].blocking_fingerprints, []);
      assertEquals(decisions[0].limits, LIMITS);

      // The run completed, the gate is open and the audit trail has one entry.
      assertEquals(await world.runStatus(), "completed");
      assertEquals(await world.taskStatus(), "completed");
      const evaluation = await gate(world);
      assertEquals(evaluation.reasons, []);
      assertEquals(evaluation.mergeBlocked, false);
      assertEquals(evaluation.decision?.decision, "proceed");
      assertEquals(evaluation.review?.id, cycle.id);
      assertEquals(evaluation.checks?.blocked, false);
      assertEquals(
        (await world.audits(REVIEW_RECORD_OPERATION, "succeeded")).length,
        1,
      );
      assertEquals(
        (await world.audits(REVIEW_RECORD_OPERATION, "denied")).length,
        0,
      );
    }));

  Deno.test("advisory findings alone proceed, are stored and do not block the gate", () =>
    withReviewedRun(async (world) => {
      const review = await world.review(0);
      const minor = finding({
        fingerprint: fingerprintOf(7),
        severity: "minor",
        path: "src/format.ts",
        line: null,
        detail: "Prefer a named constant here.",
      });
      const note = finding({ fingerprint: fingerprintOf(8), severity: "note" });
      await accept(review, review.report([minor, note]));

      const [cycle] = await world.cycles();
      assertEquals(cycle.status, "approved");
      assertEquals(cycle.finding_count, 2);
      assertEquals(cycle.blocking_count, 0);
      const stored = await world.findings(cycle.id);
      assertEquals(
        stored.map((row) => [row.fingerprint, row.severity, row.line]),
        [
          [fingerprintOf(7), "minor", null],
          [fingerprintOf(8), "note", 42],
        ],
      );
      assertEquals(stored[0].body, minor.detail);
      assertEquals(stored[0].path, "src/format.ts");
      const [decision] = await world.decisions();
      assertEquals([decision.decision, decision.reason], ["proceed", "clean"]);
      assertEquals(decision.blocking_fingerprints, []);
      assertEquals((await gate(world)).mergeBlocked, false);
    }));
}

const KEY = "magic.numbers";

/** The `FailedCheck` a decision and a repair input carry for a failed row. */
const failedCheckOf = (checkRunId: string) => ({
  checkRunId,
  checkId: KEY,
  result: "failed",
  reason: "exit_nonzero",
  exitCode: 1,
});

function registerRepairCases(): void {
  Deno.test("a clean review over a failed required check selects repair with the check run as evidence and blocks the gate (AC1)", () =>
    withReviewedRun(
      async (world, seeded) => {
        const required = seeded.rows.find((row) => row.checkId === KEY)!;
        const review = await world.review(0);
        await accept(review, review.report([]));

        // The review approved nothing by itself: the cycle is clean, the
        // decision is repair, and it names the failed required check only.
        const [cycle] = await world.cycles();
        assertEquals(cycle.status, "approved");
        const [decision] = await world.decisions();
        assertEquals([decision.decision, decision.reason], [
          "repair",
          "repair_selected",
        ]);
        assertEquals(decision.failed_checks, [failedCheckOf(required.id)]);
        assertEquals(decision.blocking_fingerprints, []);
        assertEquals(decision.review_cycle_id, cycle.id);

        // The next iteration is appended, pending, above every existing step.
        const steps = await world.steps();
        assertEquals(stepKeys(steps), [
          "brief@0",
          "implement@0",
          "check@0",
          "review@0",
          "repair@1",
          "check@1",
          "review@1",
        ]);
        assertEquals(steps.map((step) => step.position), [0, 1, 3, 4, 5, 6, 7]);
        const appended = steps.filter((step) => step.iteration === 1);
        assertEquals(
          new Set(appended.map((step) => step.status)),
          new Set(["pending"]),
        );
        // The stored input is the spec's own template, so a reader sees what
        // the step will be given; admission derives the real input from it.
        const original = (key: string) =>
          steps.find((step) => step.step_key === key && step.iteration === 0)!;
        assertEquals(appended[1].input, original("check").input);
        assertEquals(appended[2].input, original("review").input);
        assertEquals(
          (appended[0].input as Record<string, unknown>).revision,
          "$delivery.headSha",
        );
        assertEquals(await world.runStatus(), "running");
        assertEquals(await world.taskStatus() !== "failed", true);

        // The repair step resolves to the failed check run: the evidence is
        // the row, and the warn-mode lint failure is not part of it.
        const repair = await world.admit("repair", 1);
        assertEquals(repair.job.input, {
          repositoryId: world.repository.repositoryId,
          revision: HEADS[0],
          findings: [],
          failedChecks: [failedCheckOf(required.id)],
        });

        // Merge stays blocked while the repair is pending.
        const evaluation = await gate(world);
        assertEquals(evaluation.mergeBlocked, true);
        assertEquals(evaluation.reasons, ["decision_repair_pending"]);
        assertEquals(evaluation.decision?.decision, "repair");
      },
      { seed: { [KEY]: "fail", lint: "fail" } },
    ));

  Deno.test("a failing warn-mode check is kept as evidence but neither blocks the gate nor selects repair", () =>
    withReviewedRun(
      async (world, seeded) => {
        const review = await world.review(0);
        await accept(review, review.report([]));
        const [decision] = await world.decisions();
        assertEquals([decision.decision, decision.reason], [
          "proceed",
          "clean",
        ]);
        assertEquals(decision.failed_checks, []);
        // The failed row is still there for a reader of the checks.
        assertEquals(
          seeded.rows.filter((row) => row.outcome === "fail").map((row) =>
            row.checkId
          ),
          ["lint"],
        );
        assertEquals(await checkRunCount(world), 2);
        const evaluation = await gate(world);
        assertEquals(evaluation.reasons, []);
        assertEquals(
          evaluation.checks?.evaluations.map((entry) => [
            entry.requirement.checkId,
            entry.status,
            entry.blocking,
          ]),
          [[KEY, "passed", false], ["lint", "failed", false]],
        );
        assertEquals(await world.runStatus(), "completed");
      },
      { seed: { lint: "fail" } },
    ));

  Deno.test("a blocking finding over passing checks selects repair, and a second cycle that fixes it proceeds", () =>
    withReviewedRun(async (world) => {
      const blocker = finding({
        fingerprint: fingerprintOf(1),
        severity: "blocker",
        path: "src/upload.ts",
        line: 12,
        detail: "The retry loop never stops.",
      });
      const major = finding({
        fingerprint: fingerprintOf(2),
        severity: "major",
        path: "src/queue.ts",
      });
      const minor = finding({
        fingerprint: fingerprintOf(3),
        severity: "minor",
      });
      const first = await world.review(0);
      await accept(first, first.report([blocker, major, minor]));

      const [cycleZero] = await world.cycles();
      assertEquals(cycleZero.status, "changes_requested");
      assertEquals(
        [cycleZero.finding_count, cycleZero.blocking_count],
        [3, 2],
      );
      assertEquals((await world.findings(cycleZero.id)).length, 3);
      const [decisionZero] = await world.decisions();
      assertEquals([decisionZero.decision, decisionZero.reason], [
        "repair",
        "repair_selected",
      ]);
      assertEquals(decisionZero.failed_checks, []);
      assertEquals(decisionZero.blocking_fingerprints, [
        fingerprintOf(1),
        fingerprintOf(2),
      ]);

      // The repair is handed the blocking findings only, in report order.
      const repair = await world.repair(1, HEADS[1]);
      assertEquals(repair.job.input, {
        repositoryId: world.repository.repositoryId,
        revision: HEADS[0],
        findings: [blocker, major],
        failedChecks: [],
      });
      await world.check(1, HEADS[1]);
      const second = await world.review(1);
      assertEquals(second.pins.headSha, HEADS[1]);
      await accept(second, second.report([]));

      // Two cycles and two decisions, ordinals from zero, the second cycle
      // judging the repaired head and naming the repair's session.
      const cycles = await world.cycles();
      assertEquals(cycles.map((cycle) => [cycle.ordinal, cycle.status]), [
        [0, "changes_requested"],
        [1, "approved"],
      ]);
      assertEquals(cycles[1].head_sha, HEADS[1]);
      assertEquals(cycles[1].implementer_session_id, repair.sessionId);
      assertNotEquals(
        cycles[1].implementer_session_id,
        cycles[0].implementer_session_id,
      );
      assertNotEquals(cycles[1].reviewer_session_id, repair.sessionId);
      const decisions = await world.decisions();
      assertEquals(
        decisions.map((d) => [d.ordinal, d.decision, d.reason]),
        [[0, "repair", "repair_selected"], [1, "proceed", "clean"]],
      );
      assertEquals(decisions[1].head_sha, HEADS[1]);
      const steps = await world.steps();
      assertEquals(stepKeys(steps), [
        "brief@0",
        "implement@0",
        "check@0",
        "review@0",
        "repair@1",
        "check@1",
        "review@1",
      ]);
      assertEquals(
        new Set(steps.map((step) => step.status)),
        new Set(["completed"]),
      );
      assertEquals(await world.runStatus(), "completed");
      const evaluation = await gate(world);
      assertEquals(evaluation.reasons, []);
      assertEquals(evaluation.review?.id, cycles[1].id);
      assertEquals(evaluation.candidate?.headSha, HEADS[1]);
    }));

  Deno.test("the same host may implement and review in a fresh session, and both principals are recorded", () =>
    withReviewedRun(async (world) => {
      const implemented = await world.implement(HEADS[0]);
      await world.check(0, HEADS[0]);
      const review = await world.review(0, { worker: implemented.worker });
      await accept(review, review.report([]));
      const [cycle] = await world.cycles();
      assertEquals(cycle.status, "approved");
      assertEquals(cycle.reviewer_principal_id, implemented.principalId);
      assertEquals(cycle.implementer_principal_id, implemented.principalId);
      // Independence is a distinct session, not a distinct host.
      assertNotEquals(cycle.reviewer_session_id, cycle.implementer_session_id);
      assertEquals(cycle.implementer_session_id, implemented.sessionId);
    }, { bare: true }));
}

function registerStopCases(): void {
  /** The pre-failed gate step a stop appends, and the failed run it causes. */
  async function assertStopped(
    world: LoopWorld,
    reason: string,
    expected: { iteration: number; position: number },
  ) {
    const decisions = await world.decisions();
    const last = decisions.at(-1)!;
    assertEquals([last.decision, last.reason], ["stop", reason]);
    const gateSteps = (await world.steps()).filter((step) =>
      step.step_key === DELIVERY_GATE_STEP_KEY
    );
    assertEquals(gateSteps.length, 1);
    const [gateStep] = gateSteps;
    assertEquals(gateStep.status, "failed");
    assertEquals(gateStep.iteration, expected.iteration);
    assertEquals(gateStep.position, expected.position);
    assertEquals(gateStep.error, {
      code: DELIVERY_LOOP_STOPPED_CODE,
      reason,
      decisionId: last.id,
    });
    assertEquals(gateStep.output, null);
    // The roll-up failed the run and its task through the real route.
    assertEquals(await world.runStatus(), "failed");
    assertEquals(await world.taskStatus(), "failed");
    // No further iteration was appended after the stop.
    const pending = (await world.steps()).filter((step) =>
      step.status === "pending"
    );
    assertEquals(pending, []);
    const evaluation = await gate(world);
    assertEquals(evaluation.mergeBlocked, true);
    assertEquals(evaluation.reasons, [`decision_stop:${reason}`]);
    return last;
  }

  Deno.test("a blocker that survives its repair stops the run as a repeated blocker, with a failed delivery_gate step", () =>
    withReviewedRun(async (world) => {
      const blocker = (line: number) =>
        finding({
          fingerprint: fingerprintOf(1),
          severity: "blocker",
          path: "src/upload.ts",
          line,
        });
      const first = await world.review(0);
      await accept(first, first.report([blocker(12)]));
      await world.repair(1, HEADS[1]);
      await world.check(1, HEADS[1]);
      // The same issue, found again on a different line, is the same blocker.
      const second = await world.review(1);
      await accept(second, second.report([blocker(40)]));

      const cycles = await world.cycles();
      assertEquals(cycles.length, 2);
      const stopped = await assertStopped(world, "repeated_blocker", {
        iteration: 1,
        position: 8,
      });
      assertEquals(stopped.ordinal, 1);
      assertEquals(stopped.review_cycle_id, cycles[1].id);
      assertEquals(stopped.blocking_fingerprints, [fingerprintOf(1)]);
      // The review itself succeeded, so its step stays completed.
      const review = (await world.steps()).find((step) =>
        step.step_key === "review" && step.iteration === 1
      )!;
      assertEquals(review.status, "completed");
    }));

  Deno.test("a required check that fails with the same output after its repair stops as a repeated blocker", () =>
    withReviewedRun(
      async (world, seeded) => {
        const digest = seeded.rows.find((row) => row.checkId === KEY)!
          .outputDigest;
        const first = await world.review(0);
        await accept(first, first.report([]));
        await world.repair(1, HEADS[1]);
        const again = await world.check(1, HEADS[1], { [KEY]: "fail" }, {
          digest,
        });
        const second = await world.review(1);
        await accept(second, second.report([]));

        const stopped = await assertStopped(world, "repeated_blocker", {
          iteration: 1,
          position: 8,
        });
        assertEquals(stopped.failed_checks, [
          failedCheckOf(again.rows.find((row) => row.checkId === KEY)!.id),
        ]);
      },
      { seed: { [KEY]: "fail" } },
    ));

  Deno.test("a different failure output after a repair is progress, not a repeat", () =>
    withReviewedRun(
      async (world) => {
        const first = await world.review(0);
        await accept(first, first.report([]));
        await world.repair(1, HEADS[1]);
        await world.check(1, HEADS[1], { [KEY]: "fail" });
        const second = await world.review(1);
        await accept(second, second.report([]));
        const decisions = await world.decisions();
        assertEquals(
          decisions.map((d) => [d.ordinal, d.decision, d.reason]),
          [[0, "repair", "repair_selected"], [1, "repair", "repair_selected"]],
        );
        assertEquals(await world.runStatus(), "running");
      },
      { seed: { [KEY]: "fail" } },
    ));

  Deno.test("the repair cycle cap stops the third distinct blocker, with each iteration appended after the last", () =>
    withReviewedRun(async (world) => {
      const blocker = (n: number) =>
        finding({ fingerprint: fingerprintOf(n), severity: "blocker" });
      for (const n of [1, 2]) {
        const turn = await world.review(n - 1);
        await accept(turn, turn.report([blocker(n)]));
        await world.repair(n, HEADS[n]);
        await world.check(n, HEADS[n]);
        assertEquals(await world.runStatus(), "running");
      }
      const third = await world.review(2);
      await accept(third, third.report([blocker(3)]));

      const stopped = await assertStopped(world, "repair_cycles_exhausted", {
        iteration: 2,
        position: 11,
      });
      assertEquals(stopped.ordinal, 2);
      assertEquals(stopped.limits, LIMITS);
      const steps = await world.steps();
      assertEquals(
        steps.map((step) => [step.step_key, step.iteration, step.position]),
        [
          ["brief", 0, 0],
          ["implement", 0, 1],
          ["check", 0, 3],
          ["review", 0, 4],
          ["repair", 1, 5],
          ["check", 1, 6],
          ["review", 1, 7],
          ["repair", 2, 8],
          ["check", 2, 9],
          ["review", 2, 10],
          [DELIVERY_GATE_STEP_KEY, 2, 11],
        ],
      );
      const decisions = await world.decisions();
      assertEquals(
        decisions.map((d) => [d.ordinal, d.decision]),
        [[0, "repair"], [1, "repair"], [2, "stop"]],
      );
    }));

  Deno.test("a loop older than its time bound stops instead of repairing again", () =>
    withReviewedRun(async (world) => {
      const first = await world.review(0);
      await accept(
        first,
        first.report([
          finding({ fingerprint: fingerprintOf(1), severity: "blocker" }),
        ]),
      );
      await world.repair(1, HEADS[1]);
      await world.check(1, HEADS[1]);
      // The loop began 25 hours ago on the database clock.
      await world.fixture.pgDatabase.query(
        `update bakery.review_cycles
            set created_at = created_at - interval '25 hours'
          where organization_id = $1 and run_id = $2 and ordinal = 0`,
        [world.fixture.organizationId, world.runId],
      );
      const second = await world.review(1);
      await accept(
        second,
        second.report([
          finding({ fingerprint: fingerprintOf(2), severity: "blocker" }),
        ]),
      );
      await assertStopped(world, "repair_time_exhausted", {
        iteration: 1,
        position: 8,
      });
    }));

  Deno.test("a run without headroom for another repair and review stops on budget", () =>
    // Implement and the first review hold 2 of 3 dollars; another repair and
    // review need 2 more.
    withReviewedRun(async (world) => {
      const review = await world.review(0);
      await accept(
        review,
        review.report([
          finding({ fingerprint: fingerprintOf(1), severity: "blocker" }),
        ]),
      );
      await assertStopped(world, "repair_budget_exhausted", {
        iteration: 0,
        position: 5,
      });
    }, { budgetLimitUsd: "3", maxUsd: 1 }));

  Deno.test("a run with exactly the headroom for another repair and review repairs", () =>
    withReviewedRun(async (world) => {
      const review = await world.review(0);
      await accept(
        review,
        review.report([
          finding({ fingerprint: fingerprintOf(1), severity: "blocker" }),
        ]),
      );
      const [decision] = await world.decisions();
      assertEquals([decision.decision, decision.reason], [
        "repair",
        "repair_selected",
      ]);
      assertEquals(await world.runStatus(), "running");
    }, { budgetLimitUsd: "4", maxUsd: 1 }));

  Deno.test("unavailable required checks stop the run and are never sent to repair", () =>
    withReviewedRun(
      async (world) => {
        const review = await world.review(0);
        await accept(review, review.report([]));
        const stopped = await assertStopped(world, "checks_unavailable", {
          iteration: 0,
          position: 5,
        });
        assertEquals(stopped.failed_checks, []);
        assertEquals(stopped.ordinal, 0);
      },
      { seed: { [KEY]: "unavailable" } },
    ));

  Deno.test("a candidate with no check evidence stops the run as stale evidence", () =>
    withReviewedRun(async (world) => {
      await world.implement(HEADS[0]);
      // The check step finished but no row was recorded for any command.
      await world.check(0, HEADS[0], {}, { rows: false });
      const review = await world.review(0);
      await accept(review, review.report([]));
      const stopped = await assertStopped(world, "stale_evidence", {
        iteration: 0,
        position: 5,
      });
      assertEquals(stopped.failed_checks, []);
    }, { bare: true }));

  Deno.test("a failed row of an earlier head never feeds a repair decision for the repaired head", () =>
    withReviewedRun(
      async (world) => {
        const first = await world.review(0);
        await accept(first, first.report([]));
        const [repairing] = await world.decisions();
        assertEquals(repairing.decision, "repair");
        await world.repair(1, HEADS[1]);
        // The repaired head's rows exist but are older than the failed row of
        // the first head, so the newest row of the required check is the old
        // failure. It judged a different commit and says nothing about this one.
        await world.check(1, HEADS[1], {}, {
          createdAt: new Date(Date.now() - 3_600_000),
        });
        const second = await world.review(1);
        await accept(second, second.report([]));
        const stopped = await assertStopped(world, "stale_evidence", {
          iteration: 1,
          position: 8,
        });
        assertEquals(stopped.failed_checks, []);
        assertEquals(stopped.head_sha, HEADS[1]);
      },
      { seed: { [KEY]: "fail" } },
    ));
}

function registerReviewerFailureCases(): void {
  const jobStatus = async (world: LoopWorld, jobId: string) =>
    (await world.fixture.pgDatabase.query<{ status: string }>(
      "select status from bakery.jobs where organization_id = $1 and id = $2",
      [world.fixture.organizationId, jobId],
    )).rows[0].status;

  Deno.test("a review job that failed for good records a reviewer_unavailable stop with no cycle", () =>
    withReviewedRun(async (world) => {
      const review = await world.review(0);
      const response = await review.fail({
        code: "REVIEWER_UNAVAILABLE",
        retryable: false,
      });
      assertEquals(response.status, 200, await response.clone().text());

      // A review that did not run leaves a decision and no cycle or finding.
      assertEquals(await world.evidenceCounts(), {
        cycles: 0,
        findings: 0,
        decisions: 1,
      });
      const [decision] = await world.decisions();
      assertEquals(decision.ordinal, 0);
      assertEquals([decision.decision, decision.reason], [
        "stop",
        "reviewer_unavailable",
      ]);
      assertEquals(decision.review_cycle_id, null);
      assertEquals(decision.head_sha, HEADS[0]);
      assertEquals(decision.base_sha, review.pins.baseSha);
      assertEquals(decision.policy_digest, review.pins.policyDigest);
      assertEquals(decision.failed_checks, []);
      assertEquals(decision.blocking_fingerprints, []);
      assertEquals(decision.limits, LIMITS);

      const steps = await world.steps();
      const reviewStep = steps.find((step) => step.step_key === "review")!;
      assertEquals(reviewStep.status, "failed");
      assertEquals(
        (reviewStep.error as { code: string }).code,
        "REVIEWER_UNAVAILABLE",
      );
      const gateStep = steps.find((step) =>
        step.step_key === DELIVERY_GATE_STEP_KEY
      )!;
      assertEquals(gateStep.status, "failed");
      assertEquals([gateStep.iteration, gateStep.position], [0, 5]);
      assertEquals(gateStep.error, {
        code: DELIVERY_LOOP_STOPPED_CODE,
        reason: "reviewer_unavailable",
        decisionId: decision.id,
      });
      assertEquals(await world.runStatus(), "failed");
      assertEquals(await world.taskStatus(), "failed");
      assertEquals((await gate(world)).reasons, [
        "decision_stop:reviewer_unavailable",
      ]);
      const audits = await world.audits(REVIEW_STOP_OPERATION, "succeeded");
      assertEquals(audits.length, 1);
      assertEquals(audits[0].details.faultCode, "REVIEWER_UNAVAILABLE");
      assertEquals(audits[0].details.decisionId, decision.id);
    }));

  Deno.test("any other terminal review fault records review_failed, and an unregistered fault code is not echoed", () =>
    withReviewedRun(async (world) => {
      const review = await world.review(0);
      const response = await review.fail({
        code: "SOME_UNREGISTERED_WORKER_CODE",
        retryable: false,
      });
      assertEquals(response.status, 200, await response.clone().text());
      const [decision] = await world.decisions();
      assertEquals([decision.decision, decision.reason], [
        "stop",
        "review_failed",
      ]);
      assertEquals(await world.runStatus(), "failed");
      const audits = await world.audits(REVIEW_STOP_OPERATION, "succeeded");
      assertEquals(audits[0].details.faultCode, null);
    }));

  Deno.test("a retryable review fault that is requeued records nothing until the last attempt fails", () =>
    withReviewedRun(async (world) => {
      let turn = await world.review(0);
      const jobId = turn.jobId;
      // Attempts one and two are given another attempt.
      for (const attempt of [1, 2]) {
        const response = await turn.fail({
          code: "REVIEWER_UNAVAILABLE",
          retryable: true,
        });
        assertEquals(response.status, 200, await response.clone().text());
        assertEquals(await world.evidenceCounts(), {
          cycles: 0,
          findings: 0,
          decisions: 0,
        }, `attempt ${attempt}`);
        const steps = await world.steps();
        assertEquals(
          steps.some((step) => step.step_key === DELIVERY_GATE_STEP_KEY),
          false,
        );
        assertNotEquals(
          steps.find((step) => step.step_key === "review")!.status,
          "failed",
        );
        assertEquals(await jobStatus(world, jobId), "queued");
        assertEquals(await world.runStatus(), "running");
        assertEquals(
          (await world.audits(REVIEW_STOP_OPERATION)).length,
          0,
        );
        turn = await turn.reclaim();
      }
      // The third failure is the last attempt: nothing re-queues it.
      const last = await turn.fail({
        code: "REVIEWER_UNAVAILABLE",
        retryable: true,
      });
      assertEquals(last.status, 200, await last.clone().text());
      const decisions = await world.decisions();
      assertEquals(decisions.length, 1);
      assertEquals(decisions[0].reason, "reviewer_unavailable");
      assertEquals(await jobStatus(world, jobId), "failed");
      assertEquals(await world.runStatus(), "failed");
    }));
}

function registerGateCases(): void {
  Deno.test("the delivery gate reads stored facts and names each condition that blocks a proceeded candidate", () =>
    withReviewedRun(async (world, seeded) => {
      const org = world.fixture.organizationId;
      const owner = world.fixture.pgDatabase;

      // Before any review there is no decision and nothing to merge.
      const before = await gate(world);
      assertEquals(before.reasons, ["no_decision"]);
      assertEquals(before.mergeBlocked, true);
      assertEquals(before.candidate, { headSha: HEADS[0] });
      assertEquals([before.decision, before.review, before.checks], [
        null,
        null,
        null,
      ]);
      const refused = await withPgTransaction(
        world.fixture.runtimePgDatabase,
        (transaction) =>
          assertDeliveryCandidateMergeable(transaction, {
            organizationId: org,
            runId: world.runId,
          }).then(() => null, (error) => error),
      );
      assert(refused instanceof StandardError);
      assertEquals(refused.code, "STATE_CONFLICT");
      assertEquals(refused.params?.reason, "delivery_candidate_blocked");
      assertEquals(refused.params?.blockedReasons, ["no_decision"]);

      // A clean review proceeds and opens the gate.
      const review = await world.review(0);
      await accept(review, review.report([]));
      const open = await gate(world);
      assertEquals(open.reasons, []);
      assertEquals(open.checks?.blocked, false);
      await withPgTransaction(
        world.fixture.runtimePgDatabase,
        (transaction) =>
          assertDeliveryCandidateMergeable(transaction, {
            organizationId: org,
            runId: world.runId,
          }),
      );

      // A newer failed row for the same head blocks it: the checks are read
      // again, so an older decision never outlives newer evidence.
      const pin = review.pins.commands.find((c) => c.checkId === KEY)!;
      const newer = await insertCheckRun(owner, {
        organizationId: org,
        runId: world.runId,
        runStepId: seeded.stepId,
        checkId: KEY,
        result: "failed",
        reason: "exit_nonzero",
        exitCode: 1,
        headSha: HEADS[0],
        baseSha: review.pins.baseSha,
        profileDigest: review.pins.profileDigest,
        policyDigest: review.pins.policyDigest,
        subjectDigest: pin.subjectDigest,
        checkerDigest: review.pins.checkerDigest,
        createdAt: new Date(Date.now() + 60_000),
      });
      const blockedChecks = await gate(world);
      assertEquals(blockedChecks.reasons, ["checks_blocked"]);
      assertEquals(
        blockedChecks.checks?.blockedChecks.map((entry) => [
          entry.requirement.checkId,
          entry.status,
          entry.rowId,
        ]),
        [[KEY, "failed", newer]],
      );
      await owner.query("delete from bakery.check_runs where id = $1", [newer]);
      assertEquals((await gate(world)).reasons, []);

      // A cycle that no longer approves this head leaves it unreviewed.
      await owner.query(
        `update bakery.review_cycles set status = 'changes_requested'
          where organization_id = $1 and run_id = $2`,
        [org, world.runId],
      );
      assertEquals((await gate(world)).reasons, ["review_missing"]);
      await owner.query(
        `update bakery.review_cycles set status = 'approved'
          where organization_id = $1 and run_id = $2`,
        [org, world.runId],
      );

      // A candidate that moved after the decision is another commit.
      await owner.query(
        `update bakery.run_steps
            set output = jsonb_set(output, '{headSha}', to_jsonb($3::text))
          where organization_id = $1 and run_id = $2
            and step_key = 'implement'`,
        [org, world.runId, HEADS[1]],
      );
      const moved = await gate(world);
      assertEquals(moved.reasons, ["candidate_moved"]);
      assertEquals(moved.candidate, { headSha: HEADS[1] });
      assertEquals(moved.decision?.headSha, HEADS[0]);
    }));
}

function registerUnreadablePolicyGateCase(): void {
  Deno.test("the delivery gate fails closed when the policy a proceeded decision was taken under cannot be read", () =>
    withReviewedRun(async (world) => {
      const org = world.fixture.organizationId;
      const owner = world.fixture.pgDatabase;
      const review = await world.review(0);
      await accept(review, review.report([]));
      const open = await gate(world);
      assertEquals(open.reasons, []);
      assertEquals(open.mergeBlocked, false);
      const [cycle] = await world.cycles();
      const stored = await world.jobInput(review.stepId);

      // The review job's stored input holds no profile any more: the pins the
      // decision was taken under cannot be derived, so no check can be shown
      // fresh for this head and the gate blocks instead of throwing.
      const setInput = (input: unknown) =>
        owner.query(
          `update bakery.jobs set input = $3::jsonb
            where organization_id = $1 and id = $2`,
          [org, review.jobId, JSON.stringify(input)],
        );
      await setInput({});
      const emptied = await gate(world);
      assertEquals(emptied.reasons, ["checks_blocked"]);
      assertEquals(emptied.mergeBlocked, true);
      assertEquals(emptied.checks, null);
      // The decision and the approved review are still reported as stored.
      assertEquals(emptied.decision?.decision, "proceed");
      assertEquals(emptied.review?.status, "approved");
      const refused = await withPgTransaction(
        world.fixture.runtimePgDatabase,
        (transaction) =>
          assertDeliveryCandidateMergeable(transaction, {
            organizationId: org,
            runId: world.runId,
          }).then(() => null, (error) => error),
      );
      assert(refused instanceof StandardError);
      assertEquals(refused.params?.blockedReasons, ["checks_blocked"]);

      // Restoring the input opens the gate again: the block came from the
      // unreadable policy and nothing else.
      await setInput(stored);
      assertEquals((await gate(world)).reasons, []);

      // A cycle whose job is gone, or that never had one, blocks the same way.
      for (const missing of [crypto.randomUUID(), null]) {
        await owner.query(
          `update bakery.review_cycles set job_id = $3
            where organization_id = $1 and id = $2`,
          [org, cycle.id, missing],
        );
        const evaluation = await gate(world);
        assertEquals(evaluation.reasons, ["checks_blocked"]);
        assertEquals(evaluation.checks, null);
      }
      await owner.query(
        `update bakery.review_cycles set job_id = $3
          where organization_id = $1 and id = $2`,
        [org, cycle.id, review.jobId],
      );
      assertEquals((await gate(world)).reasons, []);
    }));
}

function registerLoneSurrogateCase(): void {
  Deno.test("a report holding a lone surrogate is refused as a denial through the real route, not a server error", () =>
    withReviewedRun(async (world) => {
      const owner = world.fixture.pgDatabase;
      const review = await world.review(0);
      const counts = await world.evidenceCounts();
      const steps = stepKeys(await world.steps());
      // Postgres jsonb rejects a lone surrogate, so before the verifier checked
      // for one this report reached the insert and the route answered 500.
      const cases: Array<[string, unknown, string]> = [
        [
          "detail",
          review.report([finding({ detail: "cut mid-character \ud83e" })]),
          "detail_invalid",
        ],
        [
          "path",
          review.report([finding({ path: "src/\udd50.ts" })]),
          "path_invalid",
        ],
      ];
      for (const [label, body] of cases) {
        const response = await review.post(body);
        const text = await response.clone().text();
        assertEquals(response.status, 422, `${label}: ${text}`);
        assertEquals((await response.json()).code, "VALIDATION_FAILED");
      }
      assertEquals(await world.evidenceCounts(), counts, "rows were written");
      assertEquals(stepKeys(await world.steps()), steps);
      const denied = await world.audits(REVIEW_RECORD_OPERATION, "denied");
      assertEquals(
        denied.map((entry) => entry.details),
        cases.map(
          ([, , subReason]) => ({
            code: "VALIDATION_FAILED",
            reason: "review_report_invalid",
            subReason,
          }),
        ),
      );
      assertEquals(
        (await world.audits(REVIEW_RECORD_OPERATION, "succeeded")).length,
        0,
      );
      // The attempt is still open, so the honest report is accepted.
      const attempt = await owner.query<{ status: string }>(
        `select status from bakery.job_attempts
          where organization_id = $1 and id = $2`,
        [world.fixture.organizationId, review.attemptId],
      );
      assert(["leased", "running"].includes(attempt.rows[0].status));
      await accept(
        review,
        review.report([finding({ severity: "note", detail: "\u{1F950} ok" })]),
      );
      assertEquals((await world.cycles()).length, 1);
    }));
}

function registerHttpReadCases(): void {
  Deno.test("the review reads are served over HTTP with paging, 404 and 401", () =>
    withReviewedRun(async (world) => {
      const first = await world.review(0);
      await accept(
        first,
        first.report([
          finding({ fingerprint: fingerprintOf(1), severity: "blocker" }),
        ]),
      );
      await world.repair(1, HEADS[1]);
      await world.check(1, HEADS[1]);
      const second = await world.review(1);
      await accept(second, second.report([]));
      const [cycleZero, cycleOne] = await world.cycles();

      const get = (path: string, extra: Record<string, unknown> = {}) =>
        apiCall(world.fixture, world.fixture, "GET", path, extra);
      const page = async (path: string) =>
        await expectJson<{
          items: Array<Record<string, unknown>>;
          nextCursor: string | null;
        }>(await get(path), 200);

      const reviews = await page(`/v1/runs/${world.runId}/reviews?limit=1`);
      assertEquals(reviews.items.map((item) => item.id), [cycleZero.id]);
      assert(reviews.nextCursor !== null);
      const nextReviews = await page(
        `/v1/runs/${world.runId}/reviews?limit=1&cursor=${reviews.nextCursor}`,
      );
      assertEquals(nextReviews.items.map((item) => item.id), [cycleOne.id]);
      assertEquals(nextReviews.nextCursor, null);

      const decisions = await page(
        `/v1/runs/${world.runId}/delivery-decisions`,
      );
      assertEquals(
        decisions.items.map((item) => [item.ordinal, item.decision]),
        [[0, "repair"], [1, "proceed"]],
      );
      const findings = await page(`/v1/reviews/${cycleZero.id}/findings`);
      assertEquals(findings.items.length, 1);
      // The blocker was not reported again, so a later cycle resolved it.
      assertEquals(findings.items[0].status, "resolved");

      // A run or cycle that does not exist is a 404, and so is one of another
      // organization; a caller with no credentials is a 401.
      for (
        const path of [
          `/v1/runs/${crypto.randomUUID()}/reviews`,
          `/v1/runs/${crypto.randomUUID()}/delivery-decisions`,
          `/v1/reviews/${crypto.randomUUID()}/findings`,
        ]
      ) assertEquals((await get(path)).status, 404, path);
      for (
        const path of [
          `/v1/runs/${world.runId}/reviews`,
          `/v1/runs/${world.runId}/delivery-decisions`,
          `/v1/reviews/${cycleZero.id}/findings`,
        ]
      ) {
        const response = await world.fixture.app.fetch(
          new Request(`http://localhost${path}`),
        );
        assertEquals(response.status, 401, path);
        await response.body?.cancel();
      }
    }));
}
