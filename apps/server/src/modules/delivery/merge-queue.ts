import type { Inngest } from "inngest";
import { INNGEST_EVENT_DEFINITIONS } from "@bakery/contracts/events";
import { StandardError } from "@bakery/contracts/http";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import { effectivePermissions } from "../auth/application/authorize.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import {
  dispatchMerge,
  type MergeDispatchDependencies,
} from "./merge-dispatch.ts";
import type { MergeDispatchResult } from "./merge-dispatch.ts";
import {
  assertCandidateEvidence,
  type MergeEntryBlockedReason,
} from "./merge-entries.ts";
import { PULL_REQUEST_MERGE_METHOD } from "./postgres.ts";
import type { MergeRefusalReason } from "./merge-candidate.ts";

/**
 * The merge queue (#57 slice 2): the consumer of `merge.queued`. An entry moves
 * queued -> validating -> merged or blocked, and a block stores why. One
 * active entry per repository and target branch is already guaranteed by the
 * unique index on the table, so the target merges one candidate at a time and
 * this consumer never has to order anything.
 *
 * The consumer re-reads durable state, never the event, and only an entry that
 * is still `queued` (or `validating`, when a retry resumes) is worked. An
 * entry whose merge left an unknown outcome stays `merging`: it holds the
 * target, no second merge is ever sent for it, and the settling read finishes
 * it (see `settleEntriesOfPullRequest` in merge-entries.ts).
 */

export const MERGE_QUEUE_FUNCTION_ID = "bakery-merge-queue";
const MERGE_QUEUED_EVENT = INNGEST_EVENT_DEFINITIONS["merge.queued"].name;

/** Why an entry was blocked: the dispatch refusals plus the queue's own. */
export type BlockedReason =
  | MergeRefusalReason
  | "not_permitted"
  | "evidence_changed"
  | "github_refused"
  | "not_merged"
  | "unavailable";

// Every reason the queue stores is one the merge-entry read serves, and back.
const _blockedReasonsMatch: [BlockedReason, MergeEntryBlockedReason] extends
  [MergeEntryBlockedReason, BlockedReason] ? true : never = true;
void _blockedReasonsMatch;

export type EntryOutcome =
  | Readonly<{ status: "merged" }>
  | Readonly<{ status: "merging" }>
  | Readonly<{ status: "blocked"; reason: BlockedReason }>;

/**
 * What one dispatch means for its entry. A merge the provider refused, or a
 * refusal before anything was sent, blocks with that reason. An attempt whose
 * outcome is unknown leaves the entry `merging`, never merged and never blocked:
 * the queue does not know, and says so by not moving.
 */
export function entryOutcome(result: MergeDispatchResult): EntryOutcome {
  if (result.kind === "refused") {
    return { status: "blocked", reason: result.reason };
  }
  switch (result.attempt.state) {
    case "merged":
      return { status: "merged" };
    case "refused":
      return { status: "blocked", reason: "github_refused" };
    case "unknown":
      return { status: "merging" };
  }
}

type EntryRow = {
  id: string;
  pullRequestId: string;
  repositoryId: string;
  targetBranch: string;
  runId: string;
  policyDigest: string;
  reviewCycleId: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  status: string;
  requestedById: string;
  requestId: string;
  traceId: string;
};

const ENTRY_SELECT = `select id, pull_request_id as "pullRequestId",
  repository_id as "repositoryId", target_branch as "targetBranch",
  run_id as "runId", policy_digest as "policyDigest",
  review_cycle_id as "reviewCycleId",
  expected_head_sha as "expectedHeadSha", expected_base_sha as "expectedBaseSha",
  status, requested_by_id as "requestedById", request_id as "requestId",
  trace_id as "traceId"
  from bakery.merge_entries
 where organization_id = $1 and id = $2
 for update`;

async function setEntry(
  transaction: PgTransactionClient,
  organizationId: string,
  entryId: string,
  status: "validating" | "merging" | "merged" | "blocked",
  blockedReason: BlockedReason | null,
): Promise<void> {
  await transaction.query(
    `update bakery.merge_entries
        set status = $3, blocked_reason = $4, updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2
        and status in ('queued', 'validating', 'merging')`,
    [organizationId, entryId, status, blockedReason],
  );
}

/**
 * Whether the person who queued the entry may still merge, read live now. The
 * queue acts as that person, so a member who was removed, deprovisioned or
 * demoted after queuing must not still merge through it: authority is checked
 * when the work is done, not only when it was asked for.
 */
async function requesterMayStillMerge(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<boolean> {
  try {
    const actor = await resolveOrganizationActor(
      transaction,
      principalId as never,
      organizationId as never,
    );
    return effectivePermissions(actor).includes("pullRequest:merge");
  } catch (error) {
    // A removed, disabled or deprovisioned member is not found.
    if (error instanceof StandardError) return false;
    throw error;
  }
}

export type MergeQueueRequest = {
  organizationId: string;
  mergeEntryId: string;
  traceId: string;
};

export type MergeQueueResult =
  | Readonly<{ kind: "skipped" }>
  | Readonly<{ kind: "processed"; outcome: EntryOutcome }>;

/**
 * Works one queued entry. The first transaction claims it (`validating`) and
 * commits, so the state is readable while the live read and the merge run in
 * the second. Anything that throws before an attempt is recorded leaves the
 * entry `validating`, so a retry resumes it; nothing here sends a merge twice,
 * because the dispatch records its attempt in the transaction that sends it and
 * an entry that is no longer queued or validating is skipped. `dispatch` is the
 * seam the tests use to script what the merge came to.
 */
export async function processMergeEntry(
  dependencies: MergeDispatchDependencies,
  database: PgDatabase,
  request: MergeQueueRequest,
  signal: AbortSignal,
  dispatch: typeof dispatchMerge = dispatchMerge,
): Promise<MergeQueueResult> {
  const claimed = await withPgTransaction(database, async (transaction) => {
    const entry = (await transaction.query<EntryRow>(ENTRY_SELECT, [
      request.organizationId,
      request.mergeEntryId,
    ])).rows[0];
    if (
      !entry || (entry.status !== "queued" && entry.status !== "validating")
    ) {
      return null;
    }
    if (entry.status === "queued") {
      await setEntry(
        transaction,
        request.organizationId,
        entry.id,
        "validating",
        null,
      );
    }
    return entry;
  });
  if (claimed === null) return { kind: "skipped" };

  return await withPgTransaction(database, async (transaction) => {
    // Locked again: a second consumer that raced this one finds the entry moved.
    const entry = (await transaction.query<EntryRow>(ENTRY_SELECT, [
      request.organizationId,
      claimed.id,
    ])).rows[0];
    if (!entry || entry.status !== "validating") {
      return { kind: "skipped" } as const;
    }
    // The person who queued it must still be allowed to merge; if not, nothing
    // is read from GitHub and nothing is sent.
    if (
      !await requesterMayStillMerge(
        transaction,
        request.organizationId,
        entry.requestedById,
      )
    ) {
      const outcome = {
        status: "blocked",
        reason: "not_permitted",
      } as const;
      await setEntry(
        transaction,
        request.organizationId,
        entry.id,
        "blocked",
        outcome.reason,
      );
      return { kind: "processed", outcome } as const;
    }
    // The evidence the entry was admitted on is checked again before GitHub is
    // asked anything: a pull request, review or check that no longer says the
    // same candidate blocks the entry, and says so.
    const checkRunIds = (await transaction.query<{ id: string }>(
      `select check_run_id as id from bakery.merge_entry_check_runs
        where organization_id = $1 and merge_entry_id = $2
        order by check_run_id`,
      [request.organizationId, entry.id],
    )).rows.map((row) => row.id);
    try {
      await assertCandidateEvidence(transaction, request.organizationId, {
        pullRequestId: entry.pullRequestId,
        repositoryId: entry.repositoryId,
        targetBranch: entry.targetBranch,
        expectedHeadSha: entry.expectedHeadSha,
        expectedBaseSha: entry.expectedBaseSha,
        runId: entry.runId,
        policyDigest: entry.policyDigest,
        reviewCycleId: entry.reviewCycleId,
        checkRunIds,
      });
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      const outcome = {
        status: "blocked",
        reason: "evidence_changed",
      } as const;
      await setEntry(
        transaction,
        request.organizationId,
        entry.id,
        "blocked",
        outcome.reason,
      );
      return { kind: "processed", outcome } as const;
    }
    const result = await dispatch(dependencies, transaction, {
      organizationId: request.organizationId,
      principalId: entry.requestedById,
      pullRequestId: entry.pullRequestId,
      requestId: entry.requestId,
      traceId: entry.traceId,
      signal,
    }, {
      expectedHeadSha: entry.expectedHeadSha,
      expectedBaseSha: entry.expectedBaseSha,
      mergeMethod: PULL_REQUEST_MERGE_METHOD,
    });
    const outcome = entryOutcome(result);
    await setEntry(
      transaction,
      request.organizationId,
      entry.id,
      outcome.status,
      outcome.status === "blocked" ? outcome.reason : null,
    );
    return { kind: "processed", outcome } as const;
  });
}

/**
 * Blocks an entry whose work kept failing until retries ran out, so it stops
 * holding its target. Only an entry that never reached a merge (`queued` or
 * `validating`) moves: one that is `merging` is waiting on an unknown outcome
 * and is settled by a read, never abandoned.
 */
export async function blockExhaustedEntry(
  database: PgDatabase,
  request: Pick<MergeQueueRequest, "organizationId" | "mergeEntryId">,
): Promise<void> {
  await withPgTransaction(database, async (transaction) => {
    await transaction.query(
      `update bakery.merge_entries
          set status = 'blocked', blocked_reason = 'unavailable',
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2
          and status in ('queued', 'validating')`,
      [request.organizationId, request.mergeEntryId],
    );
  });
}

function queueRequest(data: unknown): MergeQueueRequest | null {
  if (!data || typeof data !== "object") return null;
  const record = data as {
    organizationId?: unknown;
    traceId?: unknown;
    payload?: { mergeEntryId?: unknown };
  };
  const mergeEntryId = record.payload?.mergeEntryId;
  if (
    typeof record.organizationId !== "string" ||
    typeof mergeEntryId !== "string"
  ) return null;
  return {
    organizationId: record.organizationId,
    mergeEntryId,
    traceId: typeof record.traceId === "string"
      ? record.traceId
      : crypto.randomUUID(),
  };
}

/**
 * The consumer of `merge.queued`, which `mergeEntries.create` writes through
 * the outbox. One run per entry at a time; a transient failure (GitHub
 * unreachable, a serialization abort) retries from the claimed state.
 */
export function createMergeQueueWorkflow(
  options: Readonly<
    { client: Inngest; database: PgDatabase } & MergeDispatchDependencies
  >,
) {
  return options.client.createFunction(
    {
      id: MERGE_QUEUE_FUNCTION_ID,
      retries: 4,
      concurrency: [{ key: "event.data.payload.mergeEntryId", limit: 1 }],
      onFailure: async ({ event, step }) => {
        const original = event.data.event as { data?: unknown } | undefined;
        const request = queueRequest(original?.data);
        if (!request) return;
        await step.run(
          `block-exhausted-${request.mergeEntryId}`,
          () => blockExhaustedEntry(options.database, request),
        );
      },
      triggers: [{ event: MERGE_QUEUED_EVENT }],
    },
    async ({ event, step }) => {
      const request = queueRequest(event.data);
      if (!request) return { kind: "ignored" as const };
      return await step.run(
        `process-${request.mergeEntryId}`,
        () =>
          processMergeEntry(
            { github: options.github, broker: options.broker },
            options.database,
            request,
            new AbortController().signal,
          ),
      );
    },
  );
}
