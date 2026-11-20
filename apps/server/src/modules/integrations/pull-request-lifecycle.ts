/**
 * Pull request lifecycle facts for development metrics (chapter 18, #46).
 *
 * A provider read of a pull request implies a small set of lifecycle facts:
 * it was opened at created_at, merged at merged_at, closed without merge at
 * closed_at, or reopened when a pull request Bakery last saw closed reads open
 * again. Each fact is stored once per stable identity, kind and effective
 * provider time (bakery.pull_request_transitions), so duplicate or reordered
 * deliveries never add a second fact. The current row keeps the lifecycle
 * times and diff totals; a merge, once recorded, is never cleared.
 */

import type { PgTransactionClient } from "@bakery/persistence";

/** The lifecycle facts a read can imply. */
export const PullRequestTransitionKind = Object.freeze(
  {
    Opened: "opened",
    Merged: "merged",
    Closed: "closed",
    Reopened: "reopened",
  } as const,
);
export type PullRequestTransitionKind =
  typeof PullRequestTransitionKind[keyof typeof PullRequestTransitionKind];

/** How a pull request's diff totals were obtained. */
export const DiffCoverage = Object.freeze(
  {
    /** The provider's own totals for the whole diff (binary files count 0). */
    ProviderTotals: "provider_totals",
    /** No totals were read: line counts are unknown. */
    Unknown: "unknown",
  } as const,
);
export type DiffCoverage = typeof DiffCoverage[keyof typeof DiffCoverage];

/** The lifecycle part of one provider read. Null is unknown. */
export type LifecycleRead = Readonly<{
  state: "open" | "closed";
  merged: boolean;
  openedAt: Date | null;
  mergedAt: Date | null;
  closedAt: Date | null;
  providerUpdatedAt: Date;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}>;

/**
 * The facts one read implies, given the status Bakery stored before it. A
 * reopen has no provider timestamp of its own, so its effective time is the
 * read's provider updated_at, the earliest time the provider says it changed.
 */
export function lifecycleFacts(
  previousStatus: string | null,
  read: LifecycleRead,
): { kind: PullRequestTransitionKind; effectiveAt: Date }[] {
  const facts: { kind: PullRequestTransitionKind; effectiveAt: Date }[] = [];
  if (read.openedAt) {
    facts.push({
      kind: PullRequestTransitionKind.Opened,
      effectiveAt: read.openedAt,
    });
  }
  if (read.merged && read.mergedAt) {
    facts.push({
      kind: PullRequestTransitionKind.Merged,
      effectiveAt: read.mergedAt,
    });
  } else if (read.state === "closed" && !read.merged && read.closedAt) {
    facts.push({
      kind: PullRequestTransitionKind.Closed,
      effectiveAt: read.closedAt,
    });
  }
  if (previousStatus === "closed" && read.state === "open") {
    facts.push({
      kind: PullRequestTransitionKind.Reopened,
      effectiveAt: read.providerUpdatedAt,
    });
  }
  return facts;
}

function count(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Records a read's lifecycle times, diff totals and facts on a pull request
 * the caller has locked. Call it only for a read that was written or that
 * confirmed the stored state, never for a stale one: a stale read's times are
 * older than what is stored.
 */
export async function recordPullRequestLifecycle(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    pullRequestId: string;
    previousStatus: string | null;
    read: LifecycleRead;
  }>,
): Promise<void> {
  const { read } = input;
  const additions = count(read.additions);
  const deletions = count(read.deletions);
  const changedFiles = count(read.changedFiles);
  const coverage = additions !== null && deletions !== null
    ? DiffCoverage.ProviderTotals
    : DiffCoverage.Unknown;
  await transaction.query(
    `update bakery.pull_requests
        set opened_at = coalesce(opened_at, $3),
            merged_at = coalesce(merged_at, $4),
            closed_at = case when merged_at is not null then closed_at
              when $10::boolean then null
              else coalesce($5, closed_at) end,
            additions = coalesce($6, additions),
            deletions = coalesce($7, deletions),
            changed_files = coalesce($8, changed_files),
            diff_coverage = case when $6::integer is null then
              coalesce(diff_coverage, $9) else $9 end
      where organization_id = $1 and id = $2`,
    [
      input.organizationId,
      input.pullRequestId,
      read.openedAt,
      read.merged ? read.mergedAt : null,
      read.state === "closed" ? read.closedAt : null,
      additions,
      deletions,
      changedFiles,
      coverage,
      read.state === "open",
    ],
  );
  for (const fact of lifecycleFacts(input.previousStatus, read)) {
    await transaction.query(
      `insert into bakery.pull_request_transitions
         (organization_id, pull_request_id, kind, effective_at)
       values ($1, $2, $3, $4)
       on conflict (pull_request_id, kind, effective_at) do nothing`,
      [input.organizationId, input.pullRequestId, fact.kind, fact.effectiveAt],
    );
  }
}
