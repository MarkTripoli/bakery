import { assert, assertEquals, assertRejects } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createMergeEntry,
  listMergeEntries,
  type MergeEntryCreateInput,
} from "../../apps/server/src/modules/delivery/merge-entries.ts";
import { withReviewedRun } from "../helpers/review-repair/loop-world.ts";
import { HEADS } from "../helpers/review-repair/loop-world.ts";

/**
 * The merge queue over real evidence rows: a reviewed run with seeded check
 * runs gives the exact head, base and policy digest an entry must name, and
 * every refusal here is one a stale or incomplete candidate would hit.
 */

const BRANCH = "main";

type Scope = {
  organizationId: string;
  repositoryId: string;
  taskId: string;
  runId: string;
  principalId: string;
  pullRequestId: string;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  reviewCycleId: string;
  checkRunIds: string[];
};

Deno.test("the merge queue admits only the exact reviewed candidate (#40)", async () => {
  await withReviewedRun(async (world, seeded) => {
    const database = world.fixture.pgDatabase;
    const organizationId = world.repository.organizationId;
    const repositoryId = world.repository.repositoryId;

    // The candidate the review judged: one implemented head, one failing-free
    // set of seeded checks (the fixture's default implement + check), and a
    // cycle that names the same head, base and policy digest.
    const implementer = (await database.query<{ id: string }>(
      `select id from bakery.agent_sessions
        where organization_id = $1 order by created_at limit 1`,
      [organizationId],
    )).rows[0].id;
    assert(implementer !== undefined);
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
    const create = async (overrides: Partial<MergeEntryCreateInput> = {}) =>
      await withPgTransaction(
        database,
        (transaction) =>
          createMergeEntry(transaction, organizationId, principal, {
            requestId: `request-${crypto.randomUUID()}`,
            traceId: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            create: { ...input, ...overrides },
          }),
      );

    // The exact candidate is admitted, and the queue says so once.
    const admitted = await create();
    assertEquals(admitted.status, "queued");
    assertEquals(admitted.expectedHeadSha, evidence.headSha);
    assertEquals(admitted.targetBranch, BRANCH);
    assertEquals(admitted.externalEffectId, null);
    const events = await database.query<{ count: string }>(
      `select count(*)::text as count from bakery.domain_events
        where organization_id = $1 and aggregate_id = $2
          and event_type = 'merge.queued'`,
      [organizationId, admitted.id],
    );
    assertEquals(events.rows[0]?.count, "1");
    const associations = await database.query<{ count: string }>(
      `select count(*)::text as count from bakery.merge_entry_check_runs
        where organization_id = $1 and merge_entry_id = $2`,
      [organizationId, admitted.id],
    );
    assertEquals(Number(associations.rows[0]?.count), input.checkRunIds.length);

    // The same admission again answers with the entry already advancing the
    // target rather than opening a second one.
    const replayed = await create();
    assertEquals(replayed.id, admitted.id);
    const requester = (await database.query<{ name: string | null }>(
      "select display_name as name from bakery.principals where id = $1",
      [principal],
    )).rows[0];
    assertEquals(
      [admitted.requestedBy, admitted.requestedByName],
      [principal, requester?.name ?? null],
    );
    assertEquals(
      [replayed.requestedBy, replayed.requestedByName],
      [principal, requester?.name ?? null],
    );

    // A different candidate for the same repository and target is refused: one
    // target merges one candidate at a time.
    const otherHead = HEADS[1] ?? "0".repeat(40);
    const conflict = await assertRejects(() =>
      create({
        expectedHeadSha: otherHead,
      }), StandardError);
    assertEquals(conflict.code, "PRECONDITION_FAILED");

    // A head that moved since the evidence was gathered cannot be admitted.
    const moved = await assertRejects(
      () => create({ expectedHeadSha: "a".repeat(40) }),
      StandardError,
    );
    assertEquals(moved.code, "PRECONDITION_FAILED");
    assertEquals(moved.params?.reason, "head_moved");

    // A review cycle of a different candidate is stale evidence.
    const staleReview = await assertRejects(
      () => create({ reviewCycleId: crypto.randomUUID() }),
      StandardError,
    );
    assertEquals(staleReview.code, "RESOURCE_NOT_FOUND");

    // A named check run from another run is not this candidate's evidence.
    const foreignCheck = await assertRejects(
      () =>
        create({ checkRunIds: [...input.checkRunIds, crypto.randomUUID()] }),
      StandardError,
    );
    assertEquals(foreignCheck.code, "PRECONDITION_FAILED");
    assertEquals(foreignCheck.params?.reason, "check_runs_missing");

    // The list pages newest first and is bound to its repository filter.
    const page = await withPgTransaction(
      database,
      (transaction) =>
        listMergeEntries(
          transaction,
          organizationId,
          principal,
          "test-secret",
          { repositoryId, limit: 1 },
        ),
    );
    assertEquals(page.items.length, 1);
    assertEquals(page.items[0].id, admitted.id);
    assertEquals(page.nextCursor, null);

    // The pull request and run filters read one entry without listing the
    // repository's queue; every filter given must match.
    const filtered = (
      query: { pullRequestId?: string; runId?: string },
    ) =>
      withPgTransaction(
        database,
        (transaction) =>
          listMergeEntries(
            transaction,
            organizationId,
            principal,
            "test-secret",
            { repositoryId, ...query },
          ),
      );
    assertEquals(
      (await filtered({ runId: admitted.runId })).items.map((item) => item.id),
      [admitted.id],
    );
    assertEquals(
      (await filtered({ pullRequestId: admitted.pullRequestId })).items.length,
      1,
    );
    assertEquals(
      (await filtered({ runId: crypto.randomUUID() })).items.length,
      0,
    );
    assertEquals(
      (await filtered({ pullRequestId: crypto.randomUUID() })).items.length,
      0,
    );
    // A matching run with a different pull request is no match.
    assertEquals(
      (await filtered({
        runId: admitted.runId,
        pullRequestId: crypto.randomUUID(),
      })).items.length,
      0,
    );

    // The fixture deletes the organization's tasks; the pull request this test
    // added would block that, so it goes first (its entries cascade).
    await database.query(
      "delete from bakery.pull_requests where organization_id = $1",
      [organizationId],
    );
  });
});
