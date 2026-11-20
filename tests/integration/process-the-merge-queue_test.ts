import { assert, assertEquals, assertRejects } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createMergeEntry,
  type MergeEntryCreateInput,
  settleEntriesOfPullRequest,
} from "../../apps/server/src/modules/delivery/merge-entries.ts";
import type {
  MergeDispatchDependencies,
  MergeDispatchResult,
} from "../../apps/server/src/modules/delivery/merge-dispatch.ts";
import type { MergeAttempt } from "../../apps/server/src/modules/delivery/merge-attempts.ts";
import {
  blockExhaustedEntry,
  processMergeEntry,
} from "../../apps/server/src/modules/delivery/merge-queue.ts";
import { withReviewedRun } from "../helpers/review-repair/loop-world.ts";

/**
 * #57 slice 2: the queue consumer over real entry rows. The dispatch (the live
 * GitHub read and the merge) has its own test; here it is scripted, so what is
 * proven is what the queue does with each thing a dispatch can come to: the
 * entry's state, its stored reason, that nothing is worked twice, and that an
 * unknown outcome is never abandoned.
 */

const BRANCH = "main";
const NO_DEPENDENCIES = {} as unknown as MergeDispatchDependencies;
const SIGNAL = new AbortController().signal;

function attemptOf(state: MergeAttempt["state"]): MergeAttempt {
  return {
    id: crypto.randomUUID(),
    pullRequestId: crypto.randomUUID(),
    providerNumber: 91,
    repositoryId: crypto.randomUUID(),
    baseBranch: BRANCH,
    expectedHeadSha: "a".repeat(40),
    state,
    providerStatus: null,
    mergedSha: state === "merged" ? "b".repeat(40) : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    settledAt: state === "unknown" ? null : "2026-01-01T00:00:01.000Z",
  };
}

type Step = MergeDispatchResult | Error;

/** A dispatch that answers from a script and counts how often it was asked. */
function scripted(...steps: Step[]) {
  const calls = { count: 0 };
  const dispatch = () => {
    const step = steps[Math.min(calls.count, steps.length - 1)];
    calls.count += 1;
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
  return { dispatch, calls };
}

Deno.test("the merge queue works each entry once and says why it stopped (#57)", async () => {
  await withReviewedRun(async (world, seeded) => {
    const database = world.fixture.pgDatabase;
    const organizationId = world.repository.organizationId;
    const repositoryId = world.repository.repositoryId;
    const implementer = (await database.query<{ id: string }>(
      `select id from bakery.agent_sessions
        where organization_id = $1 order by created_at limit 1`,
      [organizationId],
    )).rows[0].id;
    const principal = (await database.query<{ id: string }>(
      `select principal_id as id from bakery.organization_memberships
        where organization_id = $1 and status = 'active'
        order by created_at limit 1`,
      [organizationId],
    )).rows[0].id;
    const evidence = (await database.query<{
      headSha: string;
      baseSha: string;
      policyDigest: string;
    }>(
      `select head_sha as "headSha", base_sha as "baseSha",
         policy_digest as "policyDigest"
         from bakery.check_runs
        where organization_id = $1 and id = $2`,
      [organizationId, seeded.rows[0].id],
    )).rows[0];
    assert(evidence.baseSha !== null);
    const cycleId = crypto.randomUUID();
    await database.query(
      `insert into bakery.review_cycles (
         id,organization_id,run_id,run_step_id,ordinal,reviewer_session_id,
         reviewer_principal_id,implementer_session_id,implementer_principal_id,
         head_sha,base_sha,policy_digest,status,finding_count,blocking_count
       ) values ($1,$2,$3,$4,1,$5,$6,$5,$6,$7,$8,$9,'completed',0,0)`,
      [
        cycleId,
        organizationId,
        world.runId,
        seeded.stepId,
        implementer,
        principal,
        evidence.headSha,
        evidence.baseSha,
        evidence.policyDigest,
      ],
    );
    const pullRequestId = crypto.randomUUID();
    await database.query(
      `insert into bakery.pull_requests (
         id,organization_id,task_id,repository_id,provider_number,url,head_sha,
         base_sha,status,version
       ) values ($1,$2,$3,$4,91,'https://github.com/acme/widgets/pull/91',
         $5,$6,'open',1)`,
      [
        pullRequestId,
        organizationId,
        world.taskId,
        repositoryId,
        evidence.headSha,
        evidence.baseSha,
      ],
    );
    const input: MergeEntryCreateInput = {
      pullRequestId,
      repositoryId,
      targetBranch: BRANCH,
      expectedHeadSha: evidence.headSha,
      expectedBaseSha: evidence.baseSha,
      runId: world.runId,
      policyDigest: evidence.policyDigest,
      reviewCycleId: cycleId,
      checkRunIds: seeded.rows.map((row) => row.id),
    };
    const admit = async () =>
      await withPgTransaction(
        database,
        (transaction) =>
          createMergeEntry(transaction, organizationId, principal, {
            requestId: `request-${crypto.randomUUID()}`,
            traceId: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            create: input,
          }),
      );
    const stateOf = async (id: string) =>
      (await database.query<{ status: string; reason: string | null }>(
        `select status, blocked_reason as reason from bakery.merge_entries
          where organization_id = $1 and id = $2`,
        [organizationId, id],
      )).rows[0];
    const process = (
      id: string,
      dispatch: ReturnType<typeof scripted>["dispatch"],
    ) =>
      processMergeEntry(
        NO_DEPENDENCIES,
        database,
        { organizationId, mergeEntryId: id, traceId: "trace" },
        SIGNAL,
        dispatch as never,
      );

    // The fixture deletes the organization's tasks; the pull request this test
    // added would block that, so it goes first (its entries cascade), whether
    // or not an assertion above failed: a failure here must not hide behind a
    // teardown error.
    try {
      // A merge that went through: merged, no reason, and never worked twice.
      const first = await admit();
      const merged = scripted({
        kind: "attempt",
        attempt: attemptOf("merged"),
      });
      assertEquals(
        (await process(first.id, merged.dispatch)).kind,
        "processed",
      );
      assertEquals(await stateOf(first.id), { status: "merged", reason: null });
      assertEquals((await process(first.id, merged.dispatch)).kind, "skipped");
      assertEquals(merged.calls.count, 1);

      // A refusal before anything was sent blocks with its reason.
      const moved = await admit();
      const refusing = scripted({ kind: "refused", reason: "head_moved" });
      await process(moved.id, refusing.dispatch);
      assertEquals(await stateOf(moved.id), {
        status: "blocked",
        reason: "head_moved",
      });

      // A merge GitHub refused blocks too, with its own reason.
      const declined = await admit();
      await process(
        declined.id,
        scripted({ kind: "attempt", attempt: attemptOf("refused") }).dispatch,
      );
      assertEquals(await stateOf(declined.id), {
        status: "blocked",
        reason: "github_refused",
      });

      // An unknown outcome stays merging: not worked again, not abandoned, and it
      // holds the target so no second merge can be admitted behind it.
      const unknown = await admit();
      const unsure = scripted({
        kind: "attempt",
        attempt: attemptOf("unknown"),
      });
      await process(unknown.id, unsure.dispatch);
      assertEquals(await stateOf(unknown.id), {
        status: "merging",
        reason: null,
      });
      assertEquals(
        (await process(unknown.id, unsure.dispatch)).kind,
        "skipped",
      );
      assertEquals(unsure.calls.count, 1);
      await blockExhaustedEntry(database, {
        organizationId,
        mergeEntryId: unknown.id,
      });
      assertEquals(await stateOf(unknown.id), {
        status: "merging",
        reason: null,
      });
      // The same candidate admitted again is the entry that already holds the
      // target, not a second one.
      const again = await admit();
      assertEquals(again.id, unknown.id);
      assertEquals(again.status, "merging");
      // A different candidate for the same target waits behind it: refused.
      const otherPullRequestId = crypto.randomUUID();
      await database.query(
        `insert into bakery.pull_requests (
           id,organization_id,task_id,repository_id,provider_number,url,
           head_sha,base_sha,status,version
         ) values ($1,$2,$3,$4,92,'https://github.com/acme/widgets/pull/92',
           $5,$6,'open',1)`,
        [
          otherPullRequestId,
          organizationId,
          world.taskId,
          repositoryId,
          evidence.headSha,
          evidence.baseSha,
        ],
      );
      const behind = await assertRejects(
        () =>
          withPgTransaction(
            database,
            (transaction) =>
              createMergeEntry(transaction, organizationId, principal, {
                requestId: `request-${crypto.randomUUID()}`,
                traceId:
                  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                create: { ...input, pullRequestId: otherPullRequestId },
              }),
          ),
        StandardError,
      );
      assertEquals((behind as StandardError).code, "STATE_CONFLICT");
      assertEquals(
        (behind as StandardError).params?.reason,
        "target_merge_in_progress",
      );
      // The settling read that decides it finishes the entry; nothing is sent.
      await withPgTransaction(
        database,
        (transaction) =>
          settleEntriesOfPullRequest(
            transaction,
            organizationId,
            pullRequestId,
            "refused",
          ),
      );
      assertEquals(await stateOf(unknown.id), {
        status: "blocked",
        reason: "not_merged",
      });

      // GitHub unreachable: the entry stays validating, and the retry resumes it.
      const flaky = await admit();
      const outage = scripted(
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
        { kind: "attempt", attempt: attemptOf("merged") },
      );
      await assertRejects(
        () => process(flaky.id, outage.dispatch),
        StandardError,
      );
      assertEquals(await stateOf(flaky.id), {
        status: "validating",
        reason: null,
      });
      assertEquals(
        (await process(flaky.id, outage.dispatch)).kind,
        "processed",
      );
      assertEquals(await stateOf(flaky.id), { status: "merged", reason: null });

      // Retries that ran out block the entry so it stops holding the target.
      const stuck = await admit();
      await assertRejects(
        () =>
          process(
            stuck.id,
            scripted(new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }))
              .dispatch,
          ),
        StandardError,
      );
      await blockExhaustedEntry(database, {
        organizationId,
        mergeEntryId: stuck.id,
      });
      assertEquals(await stateOf(stuck.id), {
        status: "blocked",
        reason: "unavailable",
      });

      // The queue acts as the person who queued the entry, so it asks again
      // whether they may still merge: a member removed after queuing, or
      // demoted below the merge permission, is blocked with no GitHub call.
      const membership = (await database.query<
        { role: string; status: string }
      >(
        `select role, status from bakery.organization_memberships
          where organization_id = $1 and principal_id = $2`,
        [organizationId, principal],
      )).rows[0];
      const becomes = (role: string, status: string) =>
        database.query(
          `update bakery.organization_memberships set role = $3, status = $4
            where organization_id = $1 and principal_id = $2`,
          [organizationId, principal, role, status],
        );
      try {
        for (
          const [label, role, status] of [
            ["removed", membership.role, "inactive"],
            ["demoted", "viewer", membership.status],
          ] as const
        ) {
          const queued = await admit();
          await becomes(role, status);
          const untouchedByQueue = scripted({
            kind: "attempt",
            attempt: attemptOf("merged"),
          });
          await process(queued.id, untouchedByQueue.dispatch);
          assertEquals(await stateOf(queued.id), {
            status: "blocked",
            reason: "not_permitted",
          }, label);
          assertEquals(untouchedByQueue.calls.count, 0, label);
          await becomes(membership.role, membership.status);
        }
      } finally {
        await becomes(membership.role, membership.status);
      }

      // Evidence that no longer says the same candidate blocks before GitHub is
      // asked anything.
      const changed = await admit();
      await database.query(
        `update bakery.pull_requests set head_sha = $3
          where organization_id = $1 and id = $2`,
        [organizationId, pullRequestId, "c".repeat(40)],
      );
      const untouched = scripted({
        kind: "attempt",
        attempt: attemptOf("merged"),
      });
      await process(changed.id, untouched.dispatch);
      assertEquals(await stateOf(changed.id), {
        status: "blocked",
        reason: "evidence_changed",
      });
      assertEquals(untouched.calls.count, 0);
    } finally {
      await database.query(
        "delete from bakery.pull_requests where organization_id = $1",
        [organizationId],
      );
    }
  });
});
