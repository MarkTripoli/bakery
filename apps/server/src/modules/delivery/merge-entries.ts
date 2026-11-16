import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";

/**
 * The declared merge queue (#40, B10.04): one active entry per repository and
 * target branch, joined to the exact candidate it admits — the head, the base
 * and the policy digest its check runs and review cycle were gathered under.
 *
 * The serialization itself is the database's: two partial unique indexes refuse
 * a second active entry for one repository and target branch, and a second
 * active entry for one pull request, so no code discipline is load-bearing.
 */

/** Cursor ordering of the merge-entry list: newest first. */
const MERGE_ENTRY_ORDERING = "createdAt:desc,id:desc";
const MAX_PAGE_SIZE = 100;
const TIMESTAMP_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** What `mergeEntries.create` accepts, after schema validation. */
export type MergeEntryCreateInput = {
  pullRequestId: string;
  repositoryId: string;
  targetBranch: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  runId: string;
  policyDigest: string;
  reviewCycleId: string;
  checkRunIds: readonly string[];
};

export type MergeEntryStatus =
  | "queued"
  | "validating"
  | "merging"
  | "merged"
  | "blocked"
  | "canceled";

export type MergeEntryRead = {
  id: string;
  pullRequestId: string;
  repositoryId: string;
  targetBranch: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  status: MergeEntryStatus;
  externalEffectId: string | null;
  runId: string;
  policyDigest: string;
  reviewCycleId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type EntryRow = {
  id: string;
  pull_request_id: string;
  repository_id: string;
  target_branch: string;
  expected_head_sha: string;
  expected_base_sha: string;
  status: string;
  external_effect_id: string | null;
  run_id: string;
  policy_digest: string;
  review_cycle_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  cursor_created_at: string;
};

const ENTRY_COLUMNS = `entry.id,entry.pull_request_id,entry.repository_id,
  entry.target_branch,entry.expected_head_sha,entry.expected_base_sha,
  entry.status,entry.external_effect_id,entry.run_id,entry.policy_digest,
  entry.review_cycle_id,entry.created_at,entry.updated_at,entry.version,
  to_char(entry.created_at at time zone 'UTC', '${TIMESTAMP_SQL}')
    as cursor_created_at`;

const STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "validating",
  "merging",
  "merged",
  "blocked",
  "canceled",
]);

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function entry(row: EntryRow): MergeEntryRead {
  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    repositoryId: row.repository_id,
    targetBranch: row.target_branch,
    expectedHeadSha: row.expected_head_sha,
    expectedBaseSha: row.expected_base_sha,
    status: STATUSES.has(row.status)
      ? row.status as MergeEntryStatus
      : "blocked",
    externalEffectId: row.external_effect_id,
    runId: row.run_id,
    policyDigest: row.policy_digest,
    reviewCycleId: row.review_cycle_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  };
}

/**
 * The evidence an entry is admitted on: the pull request's recorded candidate,
 * the review cycle and every check run it names must all be the same candidate
 * — this exact head, this exact base and this policy digest — and every named
 * check must have passed.
 */
async function assertCandidateEvidence(
  transaction: PgTransactionClient,
  organizationId: string,
  input: MergeEntryCreateInput,
): Promise<void> {
  const pull = (await transaction.query<{
    headSha: string;
    baseSha: string;
    state: string;
  }>(
    `select head_sha as "headSha", base_sha as "baseSha", status as "state"
       from bakery.pull_requests
      where organization_id = $1 and id = $2 and repository_id = $3`,
    [organizationId, input.pullRequestId, input.repositoryId],
  )).rows[0];
  if (!pull) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // The entry names the candidate the pull request currently is: a head or base
  // that has moved since the evidence was gathered cannot be admitted.
  if (pull.headSha !== input.expectedHeadSha) {
    throw new StandardError({
      code: "PRECONDITION_FAILED",
      params: { reason: "head_moved" },
    });
  }
  if (pull.baseSha !== input.expectedBaseSha) {
    throw new StandardError({
      code: "PRECONDITION_FAILED",
      params: { reason: "base_moved" },
    });
  }
  if (pull.state !== "open") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "pull_request_not_open" },
    });
  }

  const review = (await transaction.query<{
    headSha: string;
    baseSha: string;
    policyDigest: string;
    blocking: number;
  }>(
    `select head_sha as "headSha", base_sha as "baseSha",
       policy_digest as "policyDigest", blocking_count as "blocking"
       from bakery.review_cycles
      where organization_id = $1 and id = $2 and run_id = $3`,
    [organizationId, input.reviewCycleId, input.runId],
  )).rows[0];
  if (!review) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // The review judged this candidate and nothing else; a blocking finding on it
  // keeps the entry out of the queue.
  if (
    review.headSha !== input.expectedHeadSha ||
    review.baseSha !== input.expectedBaseSha ||
    review.policyDigest !== input.policyDigest
  ) {
    throw new StandardError({
      code: "PRECONDITION_FAILED",
      params: { reason: "review_evidence_stale" },
    });
  }
  if (review.blocking > 0) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "review_findings_blocking" },
    });
  }

  const checks = await transaction.query<{
    id: string;
    headSha: string;
    baseSha: string | null;
    policyDigest: string;
    result: string;
  }>(
    `select id, head_sha as "headSha", base_sha as "baseSha",
       policy_digest as "policyDigest", result
       from bakery.check_runs
      where organization_id = $1 and run_id = $2
        and id = any($3::uuid[])`,
    [organizationId, input.runId, input.checkRunIds],
  );
  // Every named run must exist, belong to this run and this exact candidate.
  if (checks.rows.length !== input.checkRunIds.length) {
    throw new StandardError({
      code: "PRECONDITION_FAILED",
      params: { reason: "check_runs_missing" },
    });
  }
  for (const check of checks.rows) {
    if (
      check.headSha !== input.expectedHeadSha ||
      check.baseSha !== input.expectedBaseSha ||
      check.policyDigest !== input.policyDigest
    ) {
      throw new StandardError({
        code: "PRECONDITION_FAILED",
        params: { reason: "check_evidence_stale" },
      });
    }
    if (check.result !== "passed") {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "checks_not_passed" },
      });
    }
  }
}

/**
 * Queues one merge attempt. At most one active entry exists per repository and
 * target branch, so a second admission of the same target answers with the entry
 * already advancing it instead of opening a parallel one; the same is true per
 * pull request.
 */
export async function createMergeEntry(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  input: {
    requestId: string;
    traceId: string;
    create: MergeEntryCreateInput;
  },
): Promise<MergeEntryRead> {
  const create = input.create;
  await assertCandidateEvidence(transaction, organizationId, create);
  const active = (await transaction.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from bakery.merge_entries entry
      where entry.organization_id = $1
        and entry.repository_id = $2
        and entry.target_branch = $3
        and entry.status in ('queued','validating','merging')
      order by entry.created_at, entry.id
      limit 1`,
    [organizationId, create.repositoryId, create.targetBranch],
  )).rows[0];
  if (active) {
    // The target already merges one candidate at a time: an identical admission
    // answers with that entry, and any other candidate is a state conflict.
    if (
      active.pull_request_id === create.pullRequestId &&
      active.expected_head_sha === create.expectedHeadSha &&
      active.expected_base_sha === create.expectedBaseSha
    ) return entry(active);
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "target_merge_in_progress" },
    });
  }

  const inserted = await transaction.query<EntryRow>(
    `insert into bakery.merge_entries (
       organization_id,pull_request_id,repository_id,target_branch,
       expected_head_sha,expected_base_sha,status,run_id,policy_digest,
       review_cycle_id,requested_by_id,request_id,trace_id
     ) values ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12)
     on conflict do nothing
     returning ${ENTRY_COLUMNS}`,
    [
      organizationId,
      create.pullRequestId,
      create.repositoryId,
      create.targetBranch,
      create.expectedHeadSha,
      create.expectedBaseSha,
      create.runId,
      create.policyDigest,
      create.reviewCycleId,
      principalId,
      input.requestId,
      input.traceId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    // A concurrent admission won the unique index: answer with its entry, or
    // report the conflict when it queued a different candidate.
    const winner = (await transaction.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from bakery.merge_entries entry
        where entry.organization_id = $1
          and ((entry.repository_id = $2 and entry.target_branch = $3)
            or entry.pull_request_id = $4)
          and entry.status in ('queued','validating','merging')
        order by entry.created_at, entry.id
        limit 1`,
      [
        organizationId,
        create.repositoryId,
        create.targetBranch,
        create.pullRequestId,
      ],
    )).rows[0];
    if (!winner) throw new StandardError({ code: "STATE_CONFLICT" });
    if (
      winner.pull_request_id === create.pullRequestId &&
      winner.expected_head_sha === create.expectedHeadSha &&
      winner.expected_base_sha === create.expectedBaseSha
    ) return entry(winner);
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "target_merge_in_progress" },
    });
  }

  await transaction.query(
    `insert into bakery.merge_entry_check_runs
       (organization_id,merge_entry_id,check_run_id)
     select $1,$2,unnest($3::uuid[])`,
    [organizationId, row.id, create.checkRunIds],
  );
  // The declared trigger: the dispatch consumer re-reads durable state.
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "merge.queued",
    aggregateId: row.id,
    aggregateVersion: 1,
    payload: { mergeEntryId: row.id },
    traceId: input.traceId,
    outboxDeliveryKey: `merge-entry:${row.id}`,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "mergeEntries.create",
    resourceType: "merge_entry",
    resourceId: row.id,
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      pullRequestId: create.pullRequestId,
      repositoryId: create.repositoryId,
      targetBranch: create.targetBranch,
      expectedHeadSha: create.expectedHeadSha,
      expectedBaseSha: create.expectedBaseSha,
      policyDigest: create.policyDigest,
      checkRunCount: create.checkRunIds.length,
    },
  });
  return entry(row);
}

function pageSize(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return limit;
}

function listBinding(
  organizationId: string,
  principalId: string,
  repositoryId: string | null,
): CursorBinding {
  return {
    action: "mergeEntries.list",
    principalId,
    organizationId,
    ordering: MERGE_ENTRY_ORDERING,
    filters: JSON.stringify({ repositoryId }),
    schemaVersion: 1,
  };
}

/**
 * Lists the organization's merge entries, newest first, keyset paginated on
 * (created_at, id). The cursor is bound to the repository filter and the caller.
 */
export async function listMergeEntries(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  secret: string,
  query: { repositoryId?: string; cursor?: string; limit?: number },
): Promise<{ items: MergeEntryRead[]; nextCursor: string | null }> {
  const limit = pageSize(query.limit);
  const repositoryId = query.repositoryId ?? null;
  const binding = listBinding(organizationId, principalId, repositoryId);
  const position = await decodeCursor(secret, query.cursor, binding);
  const rows = (await transaction.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from bakery.merge_entries entry
      where entry.organization_id = $1
        and ($2::uuid is null or entry.repository_id = $2)
        and ($3::timestamptz is null or (entry.created_at,entry.id) < ($3,$4::uuid))
      order by entry.created_at desc,entry.id desc
      limit $5`,
    [
      organizationId,
      repositoryId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  )).rows;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(entry),
    nextCursor: rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}
