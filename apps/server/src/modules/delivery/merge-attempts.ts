import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type {
  GitHubMergeMethod,
  GitHubMergeOutcome,
} from "../integrations/github-app.ts";

/**
 * The durable side of one merge dispatch (#40): the serialization key that
 * gives "the verified candidate" meaning across concurrent callers, the attempt
 * row written in the same transaction that dispatches, and the reconciliation
 * that settles an attempt whose answer was lost.
 *
 * Nothing here talks to GitHub. The caller reads the provider live, decides
 * with `decideMerge`, and hands the outcome here; an `unknown` outcome is
 * recorded, never retried, and settled by a later read.
 */

export type MergeAttemptState = "merged" | "refused" | "unknown";

/** What one attempt is dispatched against. */
export type MergeAttemptTarget = {
  organizationId: string;
  pullRequestId: string;
  repositoryId: string;
  providerNumber: number;
  baseBranch: string;
  expectedHeadSha: string;
  expectedBaseSha: string | null;
  mergeMethod: GitHubMergeMethod;
  requestedById: string;
  requestId: string;
  traceId: string;
};

export type MergeAttempt = {
  id: string;
  pullRequestId: string;
  providerNumber: number;
  repositoryId: string;
  baseBranch: string;
  expectedHeadSha: string;
  state: MergeAttemptState;
  providerStatus: number | null;
  mergedSha: string | null;
  createdAt: string;
  settledAt: string | null;
};

type AttemptRow = {
  id: string;
  pull_request_id: string;
  provider_number: number;
  repository_id: string;
  base_branch: string;
  expected_head_sha: string;
  state: string;
  provider_status: number | null;
  merged_sha: string | null;
  created_at: Date | string;
  settled_at: Date | string | null;
};

const ATTEMPT_COLUMNS = `id,pull_request_id,provider_number,repository_id,
  base_branch,expected_head_sha,state,provider_status,merged_sha,created_at,
  settled_at`;

const STATES: ReadonlySet<string> = new Set(["merged", "refused", "unknown"]);

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function attempt(row: AttemptRow): MergeAttempt {
  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    providerNumber: row.provider_number,
    repositoryId: row.repository_id,
    baseBranch: row.base_branch,
    expectedHeadSha: row.expected_head_sha,
    state: STATES.has(row.state) ? row.state as MergeAttemptState : "unknown",
    providerStatus: row.provider_status,
    mergedSha: row.merged_sha,
    createdAt: iso(row.created_at),
    settledAt: row.settled_at === null ? null : iso(row.settled_at),
  };
}

/**
 * Serializes merges of one repository's target branch for the rest of this
 * transaction. Taken before the live provider read, so two callers can never
 * both verify the same candidate and both dispatch: the second reads the
 * provider only after the first attempt is recorded.
 *
 * The lock is transaction-scoped, so it is released by commit, rollback or a
 * dropped connection; nothing has to unlock it.
 */
export async function lockMergeTarget(
  transaction: PgTransactionClient,
  target: {
    organizationId: string;
    repositoryId: string;
    baseBranch: string;
  },
): Promise<void> {
  await transaction.query(
    `select pg_advisory_xact_lock(
      hashtextextended(
        'bakery:merge:' || $1::text || ':' || $2::text || ':' || $3::text, 0
      )
    )`,
    [target.organizationId, target.repositoryId, target.baseBranch],
  );
}

/**
 * Records one attempt. Called in the transaction that dispatches, so a crash
 * cannot lose an attempt that may have merged: the row exists before the
 * outcome is trusted, and an `unknown` one waits for reconciliation.
 */
export async function recordMergeAttempt(
  transaction: PgTransactionClient,
  target: MergeAttemptTarget,
  outcome: GitHubMergeOutcome,
): Promise<MergeAttempt> {
  const state: MergeAttemptState = outcome.kind === "unknown"
    ? "unknown"
    : outcome.kind === "merged"
    ? "merged"
    : "refused";
  const row = (await transaction.query<AttemptRow>(
    `insert into bakery.pull_request_merge_attempts (
       organization_id,pull_request_id,repository_id,provider_number,
       base_branch,expected_head_sha,expected_base_sha,merge_method,state,
       provider_status,merged_sha,requested_by_id,request_id,trace_id,
       settled_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       case when $9::text = 'unknown' then null else current_timestamp end
     )
     returning ${ATTEMPT_COLUMNS}`,
    [
      target.organizationId,
      target.pullRequestId,
      target.repositoryId,
      target.providerNumber,
      target.baseBranch,
      target.expectedHeadSha,
      target.expectedBaseSha,
      target.mergeMethod,
      state,
      outcome.kind === "refused" ? outcome.status : null,
      outcome.kind === "merged" ? outcome.mergedSha : null,
      target.requestedById,
      target.requestId,
      target.traceId,
    ],
  )).rows[0];
  if (!row) throw new Error("MERGE_ATTEMPT_INSERT_FAILED");
  return attempt(row);
}

/** The attempts still unknown for this pull request, oldest first. */
export async function unknownMergeAttempts(
  transaction: PgTransactionClient,
  organizationId: string,
  pullRequestId: string,
): Promise<MergeAttempt[]> {
  const rows = (await transaction.query<AttemptRow>(
    `select ${ATTEMPT_COLUMNS}
       from bakery.pull_request_merge_attempts
      where organization_id = $1 and pull_request_id = $2 and state = 'unknown'
      order by created_at, id`,
    [organizationId, pullRequestId],
  )).rows;
  return rows.map(attempt);
}

/**
 * Settles one unknown attempt from a live provider read. Only an unknown row
 * moves, and the update must change exactly one row: an attempt already settled
 * by another reconciliation answers with itself instead of being rewritten.
 */
export async function settleMergeAttempt(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    attemptId: string;
    outcome: Exclude<GitHubMergeOutcome, { kind: "unknown" }>;
  },
): Promise<MergeAttempt> {
  const state: MergeAttemptState = input.outcome.kind === "merged"
    ? "merged"
    : "refused";
  const updated = await transaction.query<AttemptRow>(
    `update bakery.pull_request_merge_attempts
        set state = $3,
            provider_status = $4,
            merged_sha = $5,
            settled_at = current_timestamp
      where organization_id = $1 and id = $2 and state = 'unknown'
      returning ${ATTEMPT_COLUMNS}`,
    [
      input.organizationId,
      input.attemptId,
      state,
      input.outcome.kind === "refused" ? input.outcome.status : null,
      input.outcome.kind === "merged" ? input.outcome.mergedSha : null,
    ],
  );
  const row = updated.rows[0];
  if (row) return attempt(row);
  // Settled meanwhile by another reconciliation: answer with the row as it is.
  return await readMergeAttempt(
    transaction,
    input.organizationId,
    input.attemptId,
  );
}

export async function readMergeAttempt(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
): Promise<MergeAttempt> {
  const row = (await transaction.query<AttemptRow>(
    `select ${ATTEMPT_COLUMNS}
       from bakery.pull_request_merge_attempts
      where organization_id = $1 and id = $2`,
    [organizationId, attemptId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return attempt(row);
}

const MERGE_ATTEMPT_ORDERING = "createdAt:desc,id:desc";
const MAX_ATTEMPT_PAGE = 100;

/**
 * Lists one pull request's merge attempts, newest first, keyset paginated on
 * (created_at, id). The cursor is bound to the pull request and the caller. An
 * attempt that is still `unknown` reads as unknown: Bakery never reports a
 * merge it has not confirmed, and the answer survives a reload.
 */
export async function listMergeAttempts(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  secret: string,
  query: { pullRequestId: string; cursor?: string; limit?: number },
): Promise<{ items: MergeAttempt[]; nextCursor: string | null }> {
  const limit = query.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ATTEMPT_PAGE) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const binding: CursorBinding = {
    action: "mergeAttempts.list",
    principalId,
    organizationId,
    ordering: MERGE_ATTEMPT_ORDERING,
    filters: JSON.stringify({ pullRequestId: query.pullRequestId }),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, query.cursor, binding);
  const rows = (await transaction.query<
    AttemptRow & { cursor_created_at: string }
  >(
    `select ${ATTEMPT_COLUMNS},
            to_char(created_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
       from bakery.pull_request_merge_attempts
      where organization_id = $1 and pull_request_id = $2
        and ($3::timestamptz is null or (created_at, id) < ($3, $4::uuid))
      order by created_at desc, id desc
      limit $5`,
    [
      organizationId,
      query.pullRequestId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  )).rows;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(attempt),
    nextCursor: rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}
