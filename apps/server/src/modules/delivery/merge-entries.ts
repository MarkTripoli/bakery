import { StandardError } from "@bakery/contracts/http";
import { ACCEPTANCE_JOIN } from "./postgres.ts";
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
  /** Why the queue stopped it; null unless blocked with a recorded reason. */
  blockedReason: MergeEntryBlockedReason | null;
  requestedBy: string;
  requestedByName: string | null;
};

/** The closed set of reasons the queue records (migration 0259). */
export const MERGE_ENTRY_BLOCKED_REASONS = [
  "already_merged",
  "not_open",
  "head_moved",
  "base_moved",
  "checks_not_passed",
  "not_permitted",
  "evidence_changed",
  "github_refused",
  "not_merged",
  "unavailable",
] as const;

export type MergeEntryBlockedReason =
  typeof MERGE_ENTRY_BLOCKED_REASONS[number];

const BLOCKED_REASONS: ReadonlySet<string> = new Set(
  MERGE_ENTRY_BLOCKED_REASONS,
);

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
  blocked_reason: string | null;
  requested_by_id: string;
  requested_by_name: string | null;
  cursor_created_at: string;
};

const ENTRY_COLUMNS = `entry.id,entry.pull_request_id,entry.repository_id,
  entry.target_branch,entry.expected_head_sha,entry.expected_base_sha,
  entry.status,entry.external_effect_id,entry.run_id,entry.policy_digest,
  entry.review_cycle_id,entry.created_at,entry.updated_at,entry.version,
  entry.blocked_reason, entry.requested_by_id,
  (select principal.display_name from bakery.principals as principal
    where principal.id = entry.requested_by_id) as requested_by_name,
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
    requestedBy: row.requested_by_id,
    requestedByName: row.requested_by_name,
    blockedReason: row.blocked_reason !== null &&
        BLOCKED_REASONS.has(row.blocked_reason)
      ? row.blocked_reason as MergeEntryBlockedReason
      : null,
  };
}

/** What a merge entry is admitted against, read from Bakery's own rows. */
export type CandidateEvidence = {
  pullRequest: { headSha: string; baseSha: string; state: string } | null;
  review: {
    headSha: string;
    baseSha: string;
    policyDigest: string;
    blocking: number;
    accepted: boolean;
  } | null;
  checks: readonly {
    id: string;
    headSha: string;
    baseSha: string | null;
    policyDigest: string;
    result: string;
  }[];
};

/** Why a candidate cannot be queued, or null when every piece of it agrees. */
export type EvidenceRefusal = {
  code: "RESOURCE_NOT_FOUND" | "PRECONDITION_FAILED" | "STATE_CONFLICT";
  reason: string;
} | null;

/**
 * Whether a queued entry already advances this exact candidate. The identity is
 * the candidate — this pull request at this head and base — deliberately not
 * the run, policy, review cycle or check ids: those name the evidence a new
 * entry would be admitted on, and the queued entry was admitted by validating
 * its own. A retry from a re-run therefore answers with it rather than opening
 * a second merge of the same commit.
 */
export function sameQueuedCandidate(
  entry: {
    pullRequestId: string;
    expectedHeadSha: string;
    expectedBaseSha: string;
  },
  create: MergeEntryCreateInput,
): boolean {
  return entry.pullRequestId === create.pullRequestId &&
    entry.expectedHeadSha === create.expectedHeadSha &&
    entry.expectedBaseSha === create.expectedBaseSha;
}

/**
 * The admission rule, as a pure function over the rows: the pull request must
 * still be the head and base the caller named and still be open, its review
 * cycle must have judged that same candidate under the same policy with no
 * blocking finding, and every named check run must be this run's, this exact
 * candidate's, and passed. Nothing here reads or writes.
 */
export function evidenceRefusal(
  input: MergeEntryCreateInput,
  evidence: CandidateEvidence,
): EvidenceRefusal {
  const { pullRequest, review, checks } = evidence;
  if (pullRequest === null) {
    return { code: "RESOURCE_NOT_FOUND", reason: "pull_request_missing" };
  }
  // The entry names the candidate the pull request currently is: a head or base
  // that moved since the evidence was gathered cannot be admitted.
  if (pullRequest.headSha !== input.expectedHeadSha) {
    return { code: "PRECONDITION_FAILED", reason: "head_moved" };
  }
  if (pullRequest.baseSha !== input.expectedBaseSha) {
    return { code: "PRECONDITION_FAILED", reason: "base_moved" };
  }
  if (pullRequest.state !== "open") {
    return { code: "STATE_CONFLICT", reason: "pull_request_not_open" };
  }
  if (review === null) {
    return { code: "RESOURCE_NOT_FOUND", reason: "review_cycle_missing" };
  }
  if (
    review.headSha !== input.expectedHeadSha ||
    review.baseSha !== input.expectedBaseSha ||
    review.policyDigest !== input.policyDigest
  ) {
    return { code: "PRECONDITION_FAILED", reason: "review_evidence_stale" };
  }
  if (review.blocking > 0 && !review.accepted) {
    return { code: "STATE_CONFLICT", reason: "review_findings_blocking" };
  }
  // An entry that names no check run has no required-checks evidence to
  // admit on. The transport already refuses an empty set; this keeps the pure
  // rule honest on its own, so it can never admit a candidate that #481's
  // checksPassed([]) refuses.
  if (input.checkRunIds.length === 0) {
    return { code: "PRECONDITION_FAILED", reason: "check_runs_missing" };
  }
  if (checks.length !== input.checkRunIds.length) {
    return { code: "PRECONDITION_FAILED", reason: "check_runs_missing" };
  }
  for (const check of checks) {
    if (
      check.headSha !== input.expectedHeadSha ||
      check.baseSha !== input.expectedBaseSha ||
      check.policyDigest !== input.policyDigest
    ) {
      return { code: "PRECONDITION_FAILED", reason: "check_evidence_stale" };
    }
    if (check.result !== "passed") {
      return { code: "STATE_CONFLICT", reason: "checks_not_passed" };
    }
  }
  return null;
}

/**
 * The evidence an entry is admitted on: the pull request's recorded candidate,
 * the review cycle and every check run it names must all be the same candidate
 * — this exact head, this exact base and this policy digest — and every named
 * check must have passed.
 */
export async function assertCandidateEvidence(
  transaction: PgTransactionClient,
  organizationId: string,
  input: MergeEntryCreateInput,
): Promise<void> {
  const pull = (await transaction.query<
    { headSha: string; baseSha: string; state: string }
  >(
    `select head_sha as "headSha", base_sha as "baseSha", status as "state"
       from bakery.pull_requests
      where organization_id = $1 and id = $2 and repository_id = $3`,
    [organizationId, input.pullRequestId, input.repositoryId],
  )).rows[0] ?? null;
  const review = (await transaction.query<{
    headSha: string;
    baseSha: string;
    policyDigest: string;
    blocking: number;
    accepted: boolean;
  }>(
    `select review_cycles.head_sha as "headSha",
       review_cycles.base_sha as "baseSha",
       review_cycles.policy_digest as "policyDigest",
       review_cycles.blocking_count as "blocking",
       acceptance.decided_by is not null as "accepted"
       from bakery.review_cycles${ACCEPTANCE_JOIN}
      where review_cycles.organization_id = $1 and review_cycles.id = $2
        and review_cycles.run_id = $3`,
    [organizationId, input.reviewCycleId, input.runId],
  )).rows[0] ?? null;
  const checks = (await transaction.query<{
    id: string;
    headSha: string;
    baseSha: string | null;
    policyDigest: string;
    result: string;
  }>(
    `select id, head_sha as "headSha", base_sha as "baseSha",
       policy_digest as "policyDigest", result
       from bakery.check_runs
      where organization_id = $1 and run_id = $2 and id = any($3::uuid[])`,
    [organizationId, input.runId, input.checkRunIds],
  )).rows;
  const refusal = evidenceRefusal(input, { pullRequest: pull, review, checks });
  if (refusal === null) return;
  throw new StandardError({
    code: refusal.code,
    params: { reason: refusal.reason },
  });
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
    // "Identical" is the candidate, not the evidence that named it — see
    // sameQueuedCandidate.
    if (sameQueuedCandidate(entry(active), create)) return entry(active);
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "target_merge_in_progress" },
    });
  }

  const inserted = await transaction.query<EntryRow>(
    `insert into bakery.merge_entries as entry (
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
    if (sameQueuedCandidate(entry(winner), create)) return entry(winner);
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
  filters: {
    repositoryId: string | null;
    pullRequestId: string | null;
    runId: string | null;
  },
): CursorBinding {
  return {
    action: "mergeEntries.list",
    principalId,
    organizationId,
    ordering: MERGE_ENTRY_ORDERING,
    filters: JSON.stringify(filters),
    schemaVersion: 1,
  };
}

/**
 * Lists the organization's merge entries, newest first, keyset paginated on
 * (created_at, id). The repository, pull request and run filters narrow the
 * page (every filter given must match); the cursor is bound to all of them and
 * to the caller.
 */
export async function listMergeEntries(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  secret: string,
  query: {
    repositoryId?: string;
    pullRequestId?: string;
    runId?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: MergeEntryRead[]; nextCursor: string | null }> {
  const limit = pageSize(query.limit);
  const filters = {
    repositoryId: query.repositoryId ?? null,
    pullRequestId: query.pullRequestId ?? null,
    runId: query.runId ?? null,
  };
  const binding = listBinding(organizationId, principalId, filters);
  const position = await decodeCursor(secret, query.cursor, binding);
  const rows = (await transaction.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from bakery.merge_entries entry
      where entry.organization_id = $1
        and ($2::uuid is null or entry.repository_id = $2)
        and ($6::uuid is null or entry.pull_request_id = $6)
        and ($7::uuid is null or entry.run_id = $7)
        and ($3::timestamptz is null or (entry.created_at,entry.id) < ($3,$4::uuid))
      order by entry.created_at desc,entry.id desc
      limit $5`,
    [
      organizationId,
      filters.repositoryId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
      filters.pullRequestId,
      filters.runId,
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

/**
 * Finishes the entry of a pull request once a settling read has decided an
 * unknown attempt: merged if GitHub says it merged, blocked `not_merged` if it
 * says it did not. Only an entry that is `merging` moves; nothing is sent.
 */
export async function settleEntriesOfPullRequest(
  transaction: PgTransactionClient,
  organizationId: string,
  pullRequestId: string,
  settled: "merged" | "refused",
): Promise<void> {
  await transaction.query(
    `update bakery.merge_entries
        set status = $3, blocked_reason = $4, updated_at = now(),
            version = version + 1
      where organization_id = $1 and pull_request_id = $2
        and status = 'merging'`,
    [
      organizationId,
      pullRequestId,
      settled === "merged" ? "merged" : "blocked",
      settled === "merged" ? null : "not_merged",
    ],
  );
}
