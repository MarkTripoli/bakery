import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { FAULTS } from "../../../packages/contracts/src/http.ts";
import { REVIEW_LOOP_LIMITS } from "../../../packages/contracts/src/review-evidence.ts";
import {
  evaluateDeliveryCandidate,
  REVIEW_RECORD_OPERATION,
} from "../../../apps/server/src/modules/delivery/index.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { finding, fingerprintOf, worstCaseReviewOutput } from "./fixtures.ts";
import {
  HEADS,
  type LoopWorld,
  openLoopWorld,
  type ReviewTurn,
  withLoopFixture,
  withReviewedRun,
} from "./loop-world.ts";

// Issue #94 (B10.03) Phase 4, security lane: hostile review reports against the
// real result route, finalizer, tables and application role. A refused report
// is returned as a denial, writes no cycle, finding, decision or step, leaves
// the attempt open and appends exactly one denied audit entry whose details are
// fixed strings of the server. An accepted report is a claim the server
// recomputed: it can never approve what the check rows do not.

const KEY = "magic.numbers";

type Expected = {
  code: keyof typeof FAULTS;
  reason: string;
  subReason?: string | null;
};

type Snapshot = {
  counts: Awaited<ReturnType<LoopWorld["evidenceCounts"]>>;
  steps: string[];
  denied: number;
  succeeded: number;
};

async function snapshotOf(world: LoopWorld): Promise<Snapshot> {
  return {
    counts: await world.evidenceCounts(),
    steps: (await world.steps()).map((step) =>
      `${step.step_key}@${step.iteration}:${step.status}`
    ),
    denied: (await world.audits(REVIEW_RECORD_OPERATION, "denied")).length,
    succeeded:
      (await world.audits(REVIEW_RECORD_OPERATION, "succeeded")).length,
  };
}

async function attemptStatus(world: LoopWorld, turn: ReviewTurn) {
  return (await world.fixture.pgDatabase.query<{ status: string }>(
    "select status from bakery.job_attempts where organization_id = $1 and id = $2",
    [world.fixture.organizationId, turn.attemptId],
  )).rows[0].status;
}

/**
 * Posts `body` and asserts the route refused it with the expected problem, that
 * nothing was written, and that exactly one denied audit entry says why. The
 * attempt stays open, so a later honest report for it is still accepted.
 */
async function expectDenied(
  world: LoopWorld,
  turn: ReviewTurn,
  body: unknown,
  expected: Expected,
): Promise<void> {
  const before = await snapshotOf(world);
  const response = await turn.post(body);
  const text = await response.clone().text();
  assertEquals(response.status, FAULTS[expected.code][0], text);
  assertEquals((await response.json()).code, expected.code);
  const after = await snapshotOf(world);
  assertEquals(after.counts, before.counts, "a refused report wrote rows");
  assertEquals(after.steps, before.steps, "a refused report changed a step");
  assertEquals(after.succeeded, before.succeeded);
  assertEquals(after.denied, before.denied + 1, "one denied audit entry");
  const entries = await world.audits(REVIEW_RECORD_OPERATION, "denied");
  assertEquals(entries.at(-1)!.details, {
    code: expected.code,
    reason: expected.reason,
    subReason: expected.subReason ?? null,
  });
  assert(["leased", "running"].includes(await attemptStatus(world, turn)));
}

/** Posts `body` and asserts the contract refused it before any hook ran. */
async function expectSchemaRefused(
  world: LoopWorld,
  turn: ReviewTurn,
  body: unknown,
): Promise<void> {
  const before = await snapshotOf(world);
  const response = await turn.post(body);
  assertEquals(response.status, 422, await response.clone().text());
  assertEquals(await snapshotOf(world), before);
}

async function expectAccepted(turn: ReviewTurn, body: unknown) {
  const response = await turn.post(body);
  assertEquals(response.status, 200, await response.clone().text());
}

const blocker = (n: number) =>
  finding({ fingerprint: fingerprintOf(n), severity: "blocker" });

const independence = (subReason: string): Expected => ({
  code: "VALIDATION_FAILED",
  reason: "review_not_independent",
  subReason,
});
const invalid = (subReason: string): Expected => ({
  code: "VALIDATION_FAILED",
  reason: "review_report_invalid",
  subReason,
});

export function registerLoopSecurityCases(): void {
  registerIndependenceCases();
  registerForgeryCases();
  registerApprovalCases();
  registerReplayCases();
  registerRollbackCases();
}

function registerIndependenceCases(): void {
  Deno.test("a reviewer that names an implementing session of the run is refused with a denied audit and no rows", () =>
    withReviewedRun(async (world) => {
      const implement = (await world.steps()).find((step) =>
        step.step_key === "implement"
      )!;
      const [implementer] = await world.sessionIds(implement.id);
      const review = await world.review(0);
      // Reviewing in the implementer's own session is self-approval.
      await expectDenied(
        world,
        review,
        review.report([], { sessionId: implementer }),
        independence("session_is_implementer"),
      );
      // The honest reviewer is still accepted afterwards: a refusal consumed
      // nothing.
      await expectAccepted(review, review.report([]));
      assertEquals((await world.cycles()).length, 1);
    }));

  Deno.test("the repair session is an implementing session too: a later review cannot name it", () =>
    withReviewedRun(async (world) => {
      const first = await world.review(0);
      await expectAccepted(first, first.report([blocker(1)]));
      const repair = await world.repair(1, HEADS[1]);
      await world.check(1, HEADS[1]);
      const second = await world.review(1);
      // The repaired candidate was written in the repair session, and the
      // implement session also remains an implementing session of the run.
      const implement = (await world.steps()).find((step) =>
        step.step_key === "implement"
      )!;
      const [implementer] = await world.sessionIds(implement.id);
      for (const sessionId of [repair.sessionId, implementer]) {
        await expectDenied(
          world,
          second,
          second.report([], { sessionId }),
          independence("session_is_implementer"),
        );
      }
      await expectAccepted(second, second.report([]));
      assertEquals((await world.cycles()).length, 2);
    }));

  Deno.test("a reviewer session that was resumed, forked or checkpointed, or that is not the review step's own, is refused", () =>
    withReviewedRun(async (world) => {
      const org = world.fixture.organizationId;
      const owner = world.fixture.pgDatabase;
      const implement = (await world.steps()).find((step) =>
        step.step_key === "implement"
      )!;
      const [implementer] = await world.sessionIds(implement.id);
      const review = await world.review(0);

      // Resumed: the session continues an earlier conversation.
      await owner.query(
        `update bakery.agent_sessions set resume_ref = '{"thread":"earlier"}'
          where organization_id = $1 and id = $2`,
        [org, review.sessionId],
      );
      await expectDenied(
        world,
        review,
        review.report(),
        independence("session_resumed"),
      );
      await owner.query(
        `update bakery.agent_sessions set resume_ref = null
          where organization_id = $1 and id = $2`,
        [org, review.sessionId],
      );

      // Forked from another session.
      await owner.query(
        `update bakery.agent_sessions set parent_session_id = $3
          where organization_id = $1 and id = $2`,
        [org, review.sessionId, implementer],
      );
      await expectDenied(
        world,
        review,
        review.report(),
        independence("session_has_parent"),
      );
      await owner.query(
        `update bakery.agent_sessions set parent_session_id = null
          where organization_id = $1 and id = $2`,
        [org, review.sessionId],
      );

      // A job that carries a checkpoint could have been resumed from it.
      await owner.query(
        `update bakery.jobs set current_checkpoints = '[{"step":1}]'::jsonb
          where organization_id = $1 and id = $2`,
        [org, review.jobId],
      );
      await expectDenied(
        world,
        review,
        review.report(),
        independence("job_checkpoints"),
      );
      await owner.query(
        `update bakery.jobs set current_checkpoints = '[]'::jsonb
          where organization_id = $1 and id = $2`,
        [org, review.jobId],
      );

      // A session that does not exist.
      await expectDenied(
        world,
        review,
        review.report([], { sessionId: crypto.randomUUID() }),
        independence("session_unknown"),
      );

      // Four refusals are four denied audit entries and still no rows.
      assertEquals(
        (await world.audits(REVIEW_RECORD_OPERATION, "denied")).length,
        4,
      );
      await expectAccepted(review, review.report([]));
      assertEquals((await world.cycles()).length, 1);
    }));

  Deno.test("a review of a revision that is no longer the run's candidate is refused", () =>
    withReviewedRun(async (world) => {
      const org = world.fixture.organizationId;
      const review = await world.review(0);
      const setHead = (head: string) =>
        world.fixture.pgDatabase.query(
          `update bakery.run_steps
              set output = jsonb_set(output, '{headSha}', to_jsonb($3::text))
            where organization_id = $1 and run_id = $2
              and step_key = 'implement'`,
          [org, world.runId, head],
        );
      // The candidate moved after the review job was admitted: the report
      // judges a commit the run no longer offers for delivery.
      await setHead(HEADS[1]);
      await expectDenied(world, review, review.report(), {
        code: "VALIDATION_FAILED",
        reason: "review_candidate_moved",
      });
      await setHead(HEADS[0]);
      await expectAccepted(review, review.report());
      assertEquals((await world.cycles()).length, 1);
    }));

  Deno.test("a candidate whose implementing attempt left no completed record cannot be reviewed", () =>
    withReviewedRun(async (world) => {
      const org = world.fixture.organizationId;
      const owner = world.fixture.pgDatabase;
      const review = await world.review(0);
      const implement = (await world.steps()).find((step) =>
        step.step_key === "implement"
      )!;
      const setAttempts = (status: string) =>
        owner.query(
          `update bakery.job_attempts attempt set status = $3
             from bakery.jobs job
            where job.organization_id = attempt.organization_id
              and job.id = attempt.job_id
              and job.organization_id = $1 and job.run_step_id = $2`,
          [org, implement.id, status],
        );
      // Without a completed attempt the cycle cannot name the implementer's
      // principal, so the review is refused rather than recorded half-known.
      await setAttempts("failed");
      await expectDenied(
        world,
        review,
        review.report(),
        independence("implementer_unknown"),
      );
      await setAttempts("completed");
      await expectAccepted(review, review.report());
    }));

  Deno.test("a reviewer cannot take the review session of another run", () =>
    withLoopFixture(async (fixture) => {
      const mine = await openLoopWorld(fixture);
      const theirs = await openLoopWorld(fixture);
      try {
        for (const world of [mine, theirs]) {
          await world.implement(HEADS[0]);
          await world.check(0, HEADS[0]);
        }
        const review = await mine.review(0);
        const foreign = await theirs.review(0);
        await expectDenied(
          mine,
          review,
          review.report([], { sessionId: foreign.sessionId }),
          independence("session_not_review_step"),
        );
        // The other run is untouched by the attempt to borrow its session.
        assertEquals((await theirs.evidenceCounts()).cycles, 0);
        await expectAccepted(review, review.report([]));
      } finally {
        await mine.close();
        await theirs.close();
      }
    }));
}

function registerForgeryCases(): void {
  Deno.test("a forged head, base or policy, a duplicate or malformed finding and an over-bound report are each refused with one denied audit", () =>
    withReviewedRun(async (world) => {
      const org = world.fixture.organizationId;
      const review = await world.review(0);
      const forged = "f".repeat(40);
      const cases: Array<[string, unknown, Expected]> = [
        [
          "head",
          review.report([], { headSha: forged }),
          invalid("head_mismatch"),
        ],
        [
          "base",
          review.report([], { baseSha: forged }),
          invalid("base_mismatch"),
        ],
        [
          "policy",
          review.report([], { policyDigest: "e".repeat(64) }),
          invalid("policy_mismatch"),
        ],
        [
          "duplicate fingerprint",
          review.report([blocker(1), { ...blocker(1), line: 99 }]),
          invalid("fingerprint_duplicate"),
        ],
        [
          "uppercase fingerprint",
          review.report([
            finding({ fingerprint: "A".repeat(64), severity: "minor" }),
          ]),
          invalid("fingerprint_invalid"),
        ],
        [
          "a blocker flagged non-blocking",
          review.report([{ ...blocker(1), blocking: false }]),
          invalid("blocking_flag_mismatch"),
        ],
        [
          "a blocker hidden from the count",
          review.report([blocker(1)], { blockingFindings: 0 }),
          invalid("blocking_count_mismatch"),
        ],
        [
          "a blank detail",
          review.report([finding({ detail: "   \t " })]),
          invalid("detail_invalid"),
        ],
        [
          "a NUL in the path",
          review.report([finding({ path: "src/a\u0000b.ts" })]),
          invalid("path_invalid"),
        ],
        [
          "over the byte budget",
          review.report(worstCaseReviewOutput("x").findings),
          invalid("over_budget"),
        ],
      ];
      for (const [label, body, expected] of cases) {
        await expectDenied(world, review, body, expected).catch((error) => {
          throw new Error(
            `${label}: ${error instanceof Error ? error.message : error}`,
          );
        });
      }
      assertEquals(
        (await world.audits(REVIEW_RECORD_OPERATION, "denied")).length,
        cases.length,
      );

      // More findings than the run froze is a refusal of its own.
      await world.setLoopLimits({ maxFindings: 2 });
      await expectDenied(
        world,
        review,
        review.report([blocker(1), blocker(2), blocker(3)]),
        invalid("findings_over_limit"),
      );
      await world.setLoopLimits({
        maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
      });

      // Nothing the forgeries said reached a table; the honest report does.
      await expectAccepted(review, review.report([]));
      const [cycle] = await world.cycles();
      assertEquals(cycle.head_sha, HEADS[0]);
      assertEquals(cycle.base_sha, review.pins.baseSha);
      assertEquals(cycle.policy_digest, review.pins.policyDigest);
      assertEquals(
        (await world.fixture.pgDatabase.query(
          "select 1 from bakery.review_cycles where organization_id = $1 and head_sha = $2",
          [org, forged],
        )).rows,
        [],
      );
    }));

  Deno.test("a report the contract cannot hold is refused before any hook, with no rows and no audit entry", () =>
    withReviewedRun(async (world) => {
      const review = await world.review(0);
      const honest = review.report([blocker(1)]);
      for (
        const forged of [
          { ...honest, approved: true },
          { ...honest, allRequired: true },
          { ...honest, status: "approved" },
          { ...honest, findings: [{ ...honest.findings[0], resolved: true }] },
          // A line the int4 column could not store.
          review.report([finding({ line: 2_147_483_648 })]),
          // More findings than any run may hold.
          review.report(
            Array.from(
              { length: REVIEW_LOOP_LIMITS.maxFindings + 1 },
              (_, index) => finding({ fingerprint: fingerprintOf(index + 1) }),
            ),
          ),
        ]
      ) await expectSchemaRefused(world, review, forged);
      assertEquals(
        (await world.audits(REVIEW_RECORD_OPERATION)).length,
        0,
      );
      await expectAccepted(review, review.report([]));
    }));

  Deno.test("a review that reuses another cycle's id is refused as a conflict and records nothing", () =>
    withReviewedRun(async (world) => {
      const first = await world.review(0);
      const report = first.report([blocker(1)]);
      await expectAccepted(first, report);
      await world.repair(1, HEADS[1]);
      await world.check(1, HEADS[1]);
      const second = await world.review(1);
      await expectDenied(
        world,
        second,
        second.report([blocker(2)], { reviewId: report.reviewId }),
        { code: "STATE_CONFLICT", reason: "review_cycle_conflict" },
      );
      assertEquals((await world.cycles()).length, 1);
      await expectAccepted(second, second.report([]));
      assertEquals((await world.cycles()).length, 2);
    }));
}

function registerApprovalCases(): void {
  Deno.test("a clean review cannot approve a candidate whose required check failed: the gate stays blocked", () =>
    withReviewedRun(
      async (world) => {
        const review = await world.review(0);
        // The reviewer claims an approval: no findings, no blockers.
        await expectAccepted(review, review.report([]));
        const [decision] = await world.decisions();
        assertEquals(decision.decision, "repair");
        const evaluation = await withPgTransaction(
          world.fixture.runtimePgDatabase,
          (transaction) =>
            evaluateDeliveryCandidate(transaction, {
              organizationId: world.fixture.organizationId,
              runId: world.runId,
            }),
        );
        assertEquals(evaluation.mergeBlocked, true);
        assertEquals(evaluation.reasons, ["decision_repair_pending"]);
      },
      { seed: { [KEY]: "fail" } },
    ));

  Deno.test("check rows of another run never satisfy this run's required checks", () =>
    withLoopFixture(async (fixture) => {
      const mine = await openLoopWorld(fixture);
      const theirs = await openLoopWorld(fixture);
      try {
        // The other run has passing rows for the same commands; this one has
        // none, because its check step recorded nothing.
        await theirs.implement(HEADS[0]);
        await theirs.check(0, HEADS[0]);
        await mine.implement(HEADS[0]);
        await mine.check(0, HEADS[0], {}, { rows: false });
        const review = await mine.review(0);
        await expectAccepted(review, review.report([]));
        const [decision] = await mine.decisions();
        assertEquals([decision.decision, decision.reason], [
          "stop",
          "stale_evidence",
        ]);
        assertEquals(await mine.runStatus(), "failed");
        assertEquals(await theirs.runStatus() !== "failed", true);
      } finally {
        await mine.close();
        await theirs.close();
      }
    }));
}

function registerReplayCases(): void {
  Deno.test("a replayed accepted result records one cycle and one decision, and a changed payload at that sequence is refused", () =>
    withReviewedRun(async (world) => {
      const review = await world.review(0);
      const report = review.report([]);
      const key = crypto.randomUUID();
      const first = await review.post(report, key);
      assertEquals(first.status, 200, await first.clone().text());
      const replay = await review.post(report, key);
      assertEquals(replay.status, 200, await replay.clone().text());
      assertEquals(await world.evidenceCounts(), {
        cycles: 1,
        findings: 0,
        decisions: 1,
      });
      assertEquals(
        (await world.audits(REVIEW_RECORD_OPERATION, "succeeded")).length,
        1,
      );
      // Another report at the same sequence, under the same key or a new one,
      // is not a replay of the first.
      for (const other of [key, crypto.randomUUID()]) {
        const changed = await review.post(
          review.report([blocker(1)]),
          other,
        );
        assertEquals(
          changed.status,
          FAULTS.IDEMPOTENCY_PAYLOAD_MISMATCH[0],
          await changed.clone().text(),
        );
        assertEquals(
          (await changed.json()).code,
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
        );
      }
      assertEquals(await world.evidenceCounts(), {
        cycles: 1,
        findings: 0,
        decisions: 1,
      });
      assertEquals(await world.runStatus(), "completed");
    }));

  Deno.test("the application role can record review evidence but never rewrite or remove it", () =>
    withReviewedRun(async (world) => {
      const review = await world.review(0);
      await expectAccepted(review, review.report([blocker(1)]));
      const [cycle] = await world.cycles();
      const [stored] = await world.findings(cycle.id);
      const [decision] = await world.decisions();
      const app = world.fixture.runtimePgDatabase;
      const statements: Array<[string, unknown[]]> = [
        [
          "update bakery.review_cycles set status = 'approved' where id = $1",
          [cycle.id],
        ],
        ["delete from bakery.review_cycles where id = $1", [cycle.id]],
        [
          "update bakery.review_findings set severity = 'note' where id = $1",
          [stored.id],
        ],
        ["delete from bakery.review_findings where id = $1", [stored.id]],
        [
          "update bakery.delivery_decisions set decision = 'proceed', reason = 'clean' where id = $1",
          [decision.id],
        ],
        ["delete from bakery.delivery_decisions where id = $1", [decision.id]],
        ["truncate bakery.review_cycles", []],
      ];
      for (const [sql, params] of statements) {
        let failure: unknown;
        try {
          await app.query(sql, params);
        } catch (error) {
          failure = error;
        }
        assert(failure !== undefined, `${sql} was allowed`);
        assertEquals((failure as { code?: string }).code, "42501", sql);
      }
      // Nothing changed.
      const [after] = await world.cycles();
      assertEquals(after.status, "changes_requested");
      assertNotEquals((await world.decisions())[0].decision, "proceed");
    }));
}

/**
 * No report alone gets past the verifier and then fails: the verifier, the
 * independence rules, the candidate check and the implementer lookup all run
 * before the first insert, and the cycle is a fresh row the finalizer just
 * built. After the first insert the finalizer can refuse only on a unique key,
 * and the one key a report cannot influence is the decision ordinal
 * (`facts.decisionCount`). A decision row that already holds the next ordinal,
 * as a racing writer that committed first would leave it, therefore refuses an
 * honest report after the cycle and every finding were written.
 */
function registerRollbackCases(): void {
  Deno.test("a refusal after the cycle and its findings were written rolls them back and leaves one denied audit", () =>
    withReviewedRun(async (world) => {
      const org = world.fixture.organizationId;
      const owner = world.fixture.pgDatabase;
      const review = await world.review(0);
      // One decision exists at ordinal 1 and none at 0, so the count of
      // decisions (1) names the ordinal the next decision would take.
      const stray = crypto.randomUUID();
      await owner.query(
        `insert into bakery.delivery_decisions (
           id, organization_id, run_id, ordinal, review_cycle_id, decision,
           reason, head_sha, base_sha, policy_digest, failed_checks,
           blocking_fingerprints, limits
         ) values (
           $1, $2, $3, 1, null, 'stop', 'review_failed', $4, null, null,
           '[]'::jsonb, '[]'::jsonb, $5::jsonb
         )`,
        [
          stray,
          org,
          world.runId,
          HEADS[0],
          JSON.stringify({
            maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCycles,
            maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
            maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
          }),
        ],
      );
      assertEquals(await world.evidenceCounts(), {
        cycles: 0,
        findings: 0,
        decisions: 1,
      });

      // The report is honest and passes every check; the cycle and both of its
      // findings are inserted before the decision insert refuses.
      const report = review.report([
        blocker(1),
        finding({ fingerprint: fingerprintOf(2), severity: "note" }),
      ]);
      await expectDenied(world, review, report, {
        code: "STATE_CONFLICT",
        reason: "delivery_decision_conflict",
      });
      // Nothing of the refused report survived: no cycle, no finding, only the
      // decision that was already there, and no iteration or gate step.
      assertEquals(await world.evidenceCounts(), {
        cycles: 0,
        findings: 0,
        decisions: 1,
      });
      assertEquals((await world.decisions()).map((row) => row.id), [stray]);
      assertEquals(
        (await world.steps()).map((step) =>
          `${step.step_key}@${step.iteration}`
        ),
        ["brief@0", "implement@0", "check@0", "review@0"],
      );

      // Once the ordinal is free the same report is accepted: the refusal
      // consumed neither the attempt nor the cycle id.
      await owner.query(
        "delete from bakery.delivery_decisions where organization_id = $1 and id = $2",
        [org, stray],
      );
      await expectAccepted(review, report);
      assertEquals(await world.evidenceCounts(), {
        cycles: 1,
        findings: 2,
        decisions: 1,
      });
      assertEquals((await world.decisions())[0].ordinal, 0);
    }));
}
