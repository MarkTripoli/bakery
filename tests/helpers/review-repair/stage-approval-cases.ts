import { assert, assertEquals } from "@std/assert";
import { evaluateDeliveryCandidate } from "../../../apps/server/src/modules/delivery/index.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { apiCall } from "../fixed-coding-preset.ts";
import { finding } from "./fixtures.ts";
import { type LoopWorld, withReviewedRun } from "./loop-world.ts";

// Issue #37 (B10.03) with #57 slice 2: a task whose policy makes the review
// stage wait for a person. A clean candidate the loop lets proceed opens a
// run_stage approval for that exact delivery decision, and the candidate may
// merge only once a person approves it. The decision runs through the real
// approvals.decide route.

type StageApproval = {
  id: string;
  status: string;
  version: number;
  subject_id: string;
  subject_digest: string;
  scope: { stage: string; runId: string; headSha: string };
  decision: string | null;
};

async function requireReviewApproval(world: LoopWorld): Promise<void> {
  await world.fixture.pgDatabase.query(
    `update bakery.tasks set approval_policy = $3::jsonb
      where organization_id = $1 and id = $2`,
    [
      world.fixture.organizationId,
      world.taskId,
      JSON.stringify({ plan: "automatic", review: "human_approval" }),
    ],
  );
}

async function stageApprovals(world: LoopWorld): Promise<StageApproval[]> {
  const result = await world.fixture.pgDatabase.query<StageApproval>(
    `select id, status, version, subject_id, subject_digest, scope, decision
       from bakery.questions
      where organization_id = $1 and task_id = $2 and kind = 'approval'
        and subject_type = 'run_stage'
      order by created_at`,
    [world.fixture.organizationId, world.taskId],
  );
  return result.rows;
}

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

function decide(
  world: LoopWorld,
  approval: StageApproval,
  decision: "approve" | "request_changes" | "reject",
  comment?: string,
) {
  return apiCall(
    world.fixture,
    world.fixture,
    "POST",
    `/v1/approvals/${approval.id}/decision`,
    {
      body: {
        decision,
        ...(comment === undefined ? {} : { comment }),
        expectedVersion: approval.version,
      },
    },
  );
}

async function cleanReview(world: LoopWorld): Promise<void> {
  const review = await world.review(0);
  const response = await review.post(review.report([]));
  assertEquals(response.status, 200, await response.clone().text());
}

/**
 * The loop world's cleanup removes the run, task and conversation but not
 * conversation messages; remove the agent request a request_changes queued
 * (and any turn it started) so the conversation can be dropped.
 */
async function removeQueuedRequest(
  world: LoopWorld,
  approvalId: string,
): Promise<void> {
  const params = [
    world.fixture.organizationId,
    `approval:${approvalId}:changes`,
  ];
  await world.fixture.pgDatabase.query(
    `delete from bakery.conversation_turns
      where organization_id = $1 and trigger_message_id in (
        select id from bakery.messages
         where organization_id = $1 and client_message_id = $2)`,
    params,
  );
  await world.fixture.pgDatabase.query(
    `delete from bakery.messages
      where organization_id = $1 and client_message_id = $2`,
    params,
  );
}

export function registerStageApprovalCases(): void {
  Deno.test("with review set to human_approval, a clean candidate opens one run_stage approval and may not merge until a person approves it", () =>
    withReviewedRun(async (world) => {
      await requireReviewApproval(world);
      await cleanReview(world);

      const decisions = await world.decisions();
      assertEquals(decisions.map((row) => row.decision), ["proceed"]);
      const [approval, ...others] = await stageApprovals(world);
      assertEquals(others, []);
      assertEquals(approval.status, "open");
      assertEquals(approval.subject_id, decisions[0].id);
      assertEquals(approval.scope.stage, "review");
      assertEquals(approval.scope.runId, world.runId);
      assertEquals(approval.scope.headSha, decisions[0].head_sha);

      const pending = await gate(world);
      assertEquals(pending.mergeBlocked, true);
      assertEquals(pending.reasons, ["approval_pending"]);

      const approved = await decide(world, approval, "approve");
      assertEquals(approved.status, 200, await approved.clone().text());
      const open = await gate(world);
      assertEquals(open.reasons, []);
      assertEquals(open.mergeBlocked, false);
    }));

  Deno.test("request_changes keeps the candidate blocked and sends the comment to the task's agent; reject blocks it for good", () =>
    withReviewedRun(async (world) => {
      await requireReviewApproval(world);
      await cleanReview(world);
      const [approval] = await stageApprovals(world);
      try {
        const changes = await decide(
          world,
          approval,
          "request_changes",
          "Rename the flag before this ships.",
        );
        assertEquals(changes.status, 200, await changes.clone().text());
        assertEquals((await gate(world)).reasons, [
          "approval_changes_requested",
        ]);
        const message = await world.fixture.pgDatabase.query<{ body: string }>(
          `select body from bakery.messages
            where organization_id = $1 and client_message_id = $2`,
          [world.fixture.organizationId, `approval:${approval.id}:changes`],
        );
        assertEquals(message.rows.length, 1);
        assert(
          message.rows[0].body.includes("Rename the flag before this ships."),
        );
        // The first decision wins: the approval cannot be approved afterwards.
        const late = await decide(world, approval, "approve");
        assertEquals(late.status, 409);
      } finally {
        await removeQueuedRequest(world, approval.id);
      }
    }));

  Deno.test("a newer delivery decision supersedes the approval: deciding it is refused and changes nothing", () =>
    withReviewedRun(async (world) => {
      await requireReviewApproval(world);
      await cleanReview(world);
      const [approval] = await stageApprovals(world);
      const [proceed] = await world.decisions();
      // A later decision for the run (as a repair or a re-review would add).
      await world.fixture.pgDatabase.query(
        `insert into bakery.delivery_decisions (
           id, organization_id, run_id, ordinal, review_cycle_id, decision,
           reason, head_sha, base_sha, policy_digest, failed_checks,
           blocking_fingerprints, limits
         ) select gen_random_uuid(), organization_id, run_id, ordinal + 1,
                  review_cycle_id, 'repair', 'repair_selected', head_sha,
                  base_sha, policy_digest, failed_checks,
                  blocking_fingerprints, limits
             from bakery.delivery_decisions where id = $1`,
        [proceed.id],
      );
      const refused = await decide(world, approval, "approve");
      assertEquals(refused.status, 409);
      assert((await refused.text()).includes("approval_superseded"));
      const [after] = await stageApprovals(world);
      assertEquals(after.status, "open");
      assertEquals(after.decision, null);
    }));

  Deno.test("a rejected candidate stays blocked with its reason", () =>
    withReviewedRun(async (world) => {
      await requireReviewApproval(world);
      await cleanReview(world);
      const [approval] = await stageApprovals(world);
      const rejected = await decide(world, approval, "reject");
      assertEquals(rejected.status, 200, await rejected.clone().text());
      assertEquals((await gate(world)).reasons, ["approval_rejected"]);
    }));

  Deno.test("an automatic review stage opens no approval and merges as before", () =>
    withReviewedRun(async (world) => {
      await cleanReview(world);
      assertEquals(await stageApprovals(world), []);
      assertEquals((await gate(world)).reasons, []);
    }));

  Deno.test("a candidate that needs repair opens no approval: only a proceed decision is asked about", () =>
    withReviewedRun(async (world) => {
      await requireReviewApproval(world);
      const review = await world.review(0);
      const response = await review.post(review.report([finding()]));
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals((await world.decisions()).map((row) => row.decision), [
        "repair",
      ]);
      assertEquals(await stageApprovals(world), []);
    }));
}
