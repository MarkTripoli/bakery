import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  type CheckKind,
  type CheckReason,
  type CheckResult,
  isCheckKind,
  isCheckReason,
  isCheckResult,
} from "@bakery/contracts/check-evidence";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  isRepositoryRuleKey,
  type RepositoryRuleKey,
} from "@bakery/contracts/repository-rules";
import {
  isDeliveryDecision,
  isDeliveryDecisionReason,
  isReviewSeverity,
} from "@bakery/contracts/review-evidence";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { effectivePermissions } from "../auth/application/authorize.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  DECISION_REVIEW_STATUSES,
  type DecisionReviewStatus,
} from "../review-loop/decision.ts";

function isDecisionReviewStatus(value: string): value is DecisionReviewStatus {
  return (DECISION_REVIEW_STATUSES as readonly string[]).includes(value);
}

const CHECK_RUN_ORDERING = "createdAt:asc,id:asc";
const CHECK_RUN_COLUMNS =
  "id, run_id, run_step_id, check_id, kind, rule_key, " +
  "result, reason, exit_code, duration_ms, output_digest, evidence_version_id, " +
  "provider_run_id, head_sha, base_sha, profile_digest, policy_digest, " +
  "subject_digest, checker_digest, title_digest, body_digest, " +
  "merge_message_digest, commit_selection_digest, created_at";

type CursorQuery = z.output<typeof contractSchemas.CursorQuery>;
type CheckRunPage = z.output<typeof contractSchemas["Page<CheckRun>"]>;

type CheckRunRow = {
  id: string;
  run_id: string;
  run_step_id: string | null;
  check_id: string;
  kind: string;
  rule_key: string | null;
  result: string;
  reason: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_digest: string | null;
  evidence_version_id: string | null;
  provider_run_id: string | null;
  head_sha: string;
  base_sha: string | null;
  profile_digest: string | null;
  policy_digest: string;
  subject_digest: string;
  checker_digest: string | null;
  title_digest: string | null;
  body_digest: string | null;
  merge_message_digest: string | null;
  commit_selection_digest: string | null;
  created_at: Date | string;
};

type KeysetCheckRunRow = CheckRunRow & {
  cursor_created_at: string;
  pull_request_id: string | null;
};

/** The `CheckRun` projection; the generated schema types it only as JSON. */
type CheckRunOutput = {
  readonly id: string;
  readonly runId: string;
  readonly runStepId: string | null;
  readonly pullRequestId: string | null;
  readonly checkId: string;
  readonly checkName: string;
  readonly kind: CheckKind;
  readonly ruleKey: RepositoryRuleKey | null;
  readonly headSha: string;
  readonly baseSha: string | null;
  readonly profileDigest: string | null;
  readonly policyDigest: string;
  readonly subjectDigest: string;
  readonly checkerDigest: string | null;
  readonly titleDigest: string | null;
  readonly bodyDigest: string | null;
  readonly mergeMessageDigest: string | null;
  readonly commitSelectionDigest: string | null;
  readonly result: CheckResult;
  readonly reason: CheckReason;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly outputDigest: string | null;
  readonly evidenceVersionId: string | null;
  readonly providerRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: 1;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function checkRunBinding(
  organizationId: string,
  principalId: string,
  runId: string,
): CursorBinding {
  return {
    action: "checks.list",
    principalId,
    organizationId,
    ordering: CHECK_RUN_ORDERING,
    filters: JSON.stringify({ runId }),
    schemaVersion: 1,
  };
}

/**
 * Rows are immutable evidence, so `updatedAt` mirrors `createdAt` and
 * `version` is 1. `result` and `reason` pass through unchanged: a failed and an
 * unavailable check must stay distinguishable to every reader.
 */
function toCheckRun(row: KeysetCheckRunRow): CheckRunOutput {
  if (
    !isCheckKind(row.kind) || !isCheckResult(row.result) ||
    !isCheckReason(row.reason) ||
    (row.rule_key !== null && !isRepositoryRuleKey(row.rule_key))
  ) {
    throw new Error("DELIVERY_READ_CHECK_RUN_INVALID");
  }
  const createdAt = toIso(row.created_at);
  return {
    id: row.id,
    runId: row.run_id,
    runStepId: row.run_step_id,
    pullRequestId: row.pull_request_id,
    checkId: row.check_id,
    checkName: row.check_id,
    kind: row.kind,
    ruleKey: row.rule_key,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    profileDigest: row.profile_digest,
    policyDigest: row.policy_digest,
    subjectDigest: row.subject_digest,
    checkerDigest: row.checker_digest,
    titleDigest: row.title_digest,
    bodyDigest: row.body_digest,
    mergeMessageDigest: row.merge_message_digest,
    commitSelectionDigest: row.commit_selection_digest,
    result: row.result,
    reason: row.reason,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    outputDigest: row.output_digest,
    evidenceVersionId: row.evidence_version_id,
    providerRunId: row.provider_run_id,
    createdAt,
    updatedAt: createdAt,
    version: 1,
  };
}

/**
 * `checks.list`: one run's check rows, oldest first, keyed by creation time and
 * id so a page boundary survives rows being appended. Organization isolation is
 * the explicit `organization_id` predicate on both reads; a run outside the
 * caller's organization is indistinguishable from a missing one.
 */
export function createChecksListHandler(secret: string) {
  return async (
    context: ActionContext,
    input: CursorQuery,
  ): Promise<CheckRunPage> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const runId = context.params.id;
    if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const run = await transaction.query<{ id: string }>(
      `select id
         from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
      [organizationId, runId],
    );
    if (!run.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const binding = checkRunBinding(organizationId, principalId, runId);
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<KeysetCheckRunRow>(
      `select ${CHECK_RUN_COLUMNS},
        (
                select pull_request.id
                  from bakery.pull_requests as pull_request
                 where pull_request.organization_id = check_runs.organization_id
                   and pull_request.run_id = check_runs.run_id
                   and pull_request.head_sha = check_runs.head_sha
                 order by pull_request.provider_number asc
                 limit 1
              ) as pull_request_id,
        to_char(
          created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as cursor_created_at
         from bakery.check_runs
        where organization_id = $1
          and run_id = $2
          and (
            $3::timestamptz is null or
            (created_at, id) > ($3::timestamptz, $4::uuid)
          )
        order by created_at asc, id asc
        limit $5`,
      [
        organizationId,
        runId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toCheckRun),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

type ReviewCyclePage = z.output<typeof contractSchemas["Page<ReviewCycle>"]>;
type ReviewFindingPage = z.output<
  typeof contractSchemas["Page<ReviewFinding>"]
>;
type DeliveryDecisionPage = z.output<
  typeof contractSchemas["Page<DeliveryDecision>"]
>;

/** Cycles and decisions list in ordinal order; the ordinal is the position. */
const ORDINAL_ORDERING = "position:asc,iteration:asc,id:asc";
const REVIEW_FINDING_ORDERING = "createdAt:asc,id:asc";

export const REVIEW_CYCLE_COLUMNS =
  "id, run_id, run_step_id, ordinal, reviewer_session_id, " +
  "reviewer_principal_id, implementer_session_id, implementer_principal_id, " +
  "head_sha, base_sha, policy_digest, status, finding_count, blocking_count, " +
  "created_at";

/**
 * The owner's accept-with-reason decision on a review, read from the decisions
 * ledger: the latest such entry whose subject is this review, joined once per
 * row. The review row is immutable, so the acceptance is a separate record
 * shown beside it. Use with `ACCEPTANCE_JOIN` after `from bakery.review_cycles`.
 */
export const ACCEPTANCE_COLUMNS =
  "acceptance.decided_by as accepted_by, acceptance.decided_at as accepted_at, " +
  "acceptance.reason as accept_reason";

export const ACCEPTANCE_JOIN = `
  left join lateral (
    select entry.decided_by, entry.decided_at, entry.reason
      from bakery.decisions_ledger as entry
     where entry.organization_id = review_cycles.organization_id
       and entry.kind = 'accept_with_reason' and entry.subject_kind = 'review'
       and entry.subject_id = review_cycles.id
     order by entry.decided_at desc, entry.id desc
     limit 1
  ) as acceptance on true`;

const DELIVERY_DECISION_COLUMNS =
  "id, run_id, ordinal, review_cycle_id, decision, reason, head_sha, " +
  "base_sha, policy_digest, failed_checks, blocking_fingerprints, limits, " +
  "created_at";

export type ReviewCycleRow = {
  id: string;
  run_id: string;
  run_step_id: string;
  ordinal: number;
  reviewer_session_id: string;
  reviewer_principal_id: string;
  implementer_session_id: string;
  implementer_principal_id: string;
  head_sha: string;
  base_sha: string;
  policy_digest: string;
  status: string;
  finding_count: number;
  blocking_count: number;
  created_at: Date | string;
  pull_request_id: string | null;
  accepted_by: string | null;
  accepted_at: Date | string | null;
  accept_reason: string | null;
};

type DeliveryDecisionRow = {
  id: string;
  run_id: string;
  ordinal: number;
  review_cycle_id: string | null;
  decision: string;
  reason: string;
  head_sha: string;
  base_sha: string | null;
  policy_digest: string | null;
  failed_checks: unknown;
  blocking_fingerprints: unknown;
  limits: unknown;
  created_at: Date | string;
};

type ReviewFindingRow = {
  id: string;
  review_cycle_id: string;
  fingerprint: string;
  severity: string;
  path: string;
  line: number | null;
  body: string;
  created_at: Date | string;
  cursor_created_at: string;
  is_open: boolean;
};

/** The `ReviewCycle` projection; rows are immutable, so `updatedAt` is `createdAt`. */
export function toReviewCycle(row: ReviewCycleRow) {
  if (!isDecisionReviewStatus(row.status)) {
    throw new Error("DELIVERY_READ_REVIEW_CYCLE_INVALID");
  }
  const createdAt = toIso(row.created_at);
  return {
    id: row.id,
    runId: row.run_id,
    runStepId: row.run_step_id,
    ordinal: row.ordinal,
    pullRequestId: row.pull_request_id,
    reviewerSessionId: row.reviewer_session_id,
    reviewerPrincipalId: row.reviewer_principal_id,
    implementerSessionId: row.implementer_session_id,
    implementerPrincipalId: row.implementer_principal_id,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    policyDigest: row.policy_digest,
    status: row.status,
    findingCount: row.finding_count,
    blockingCount: row.blocking_count,
    artifactVersionId: null,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at === null ? null : toIso(row.accepted_at),
    acceptReason: row.accept_reason,
    createdAt,
    updatedAt: createdAt,
    version: 1,
  };
}

/** The `DeliveryDecision` projection. */
function toDeliveryDecision(row: DeliveryDecisionRow) {
  if (
    !isDeliveryDecision(row.decision) ||
    !isDeliveryDecisionReason(row.reason) ||
    !Array.isArray(row.failed_checks) ||
    !Array.isArray(row.blocking_fingerprints) ||
    row.limits === null || typeof row.limits !== "object"
  ) throw new Error("DELIVERY_READ_DECISION_INVALID");
  const createdAt = toIso(row.created_at);
  return {
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    reviewCycleId: row.review_cycle_id,
    decision: row.decision,
    reason: row.reason,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    policyDigest: row.policy_digest,
    failedChecks: row.failed_checks,
    blockingFingerprints: row.blocking_fingerprints,
    limits: row.limits,
    createdAt,
    updatedAt: createdAt,
    version: 1,
  };
}

/** The `ReviewFinding` projection; `status` is derived by the query. */
function toReviewFinding(row: ReviewFindingRow) {
  if (!isReviewSeverity(row.severity)) {
    throw new Error("DELIVERY_READ_REVIEW_FINDING_INVALID");
  }
  const createdAt = toIso(row.created_at);
  return {
    id: row.id,
    reviewCycleId: row.review_cycle_id,
    fingerprint: row.fingerprint,
    severity: row.severity,
    path: row.path,
    line: row.line,
    body: row.body,
    status: row.is_open ? "open" : "resolved",
    resolutionArtifactId: null,
    remoteCommentId: null,
    createdAt,
    updatedAt: createdAt,
    version: 1,
  };
}

/** Throws `RESOURCE_NOT_FOUND` unless the run belongs to the organization. */
async function assertRunVisible(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string | undefined,
): Promise<string> {
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const run = await transaction.query<{ id: string }>(
    `select id from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  if (!run.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return runId;
}

function runBinding(
  action: string,
  organizationId: string,
  principalId: string,
  runId: string,
): CursorBinding {
  return {
    action,
    principalId,
    organizationId,
    ordering: ORDINAL_ORDERING,
    filters: JSON.stringify({ runId }),
    schemaVersion: 1,
  };
}

/**
 * `runReviews.list`: one run's review cycles in ordinal order. The ordinal is
 * the keyset position (unique per run), so a page boundary survives cycles
 * being appended. Organization isolation is the explicit predicate on both
 * reads; a run outside the caller's organization reads as missing.
 */
export function createRunReviewsListHandler(secret: string) {
  return async (
    context: ActionContext,
    input: CursorQuery,
  ): Promise<ReviewCyclePage> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const runId = await assertRunVisible(
      transaction,
      organizationId,
      context.params.id,
    );
    const binding = runBinding(
      "runReviews.list",
      organizationId,
      principalId,
      runId,
    );
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<ReviewCycleRow>(
      `select ${REVIEW_CYCLE_COLUMNS},
              (
                select pull_request.id
                  from bakery.pull_requests as pull_request
                 where pull_request.organization_id = review_cycles.organization_id
                   and pull_request.run_id = review_cycles.run_id
                   and pull_request.head_sha = review_cycles.head_sha
                 order by pull_request.provider_number asc
                 limit 1
              ) as pull_request_id,
              ${ACCEPTANCE_COLUMNS}
         from bakery.review_cycles${ACCEPTANCE_JOIN}
        where review_cycles.organization_id = $1 and review_cycles.run_id = $2
          and (
            $3::integer is null or (ordinal, id) > ($3::integer, $4::uuid)
          )
        order by ordinal asc, id asc
        limit $5`,
      [
        organizationId,
        runId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toReviewCycle),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: last.ordinal,
          iteration: 0,
          id: last.id,
        })
        : null,
    } as ReviewCyclePage;
  };
}

/**
 * `runDeliveryDecisions.list`: one run's delivery decisions in ordinal order,
 * paged like `runReviews.list`. The latest ordinal is the decision that governs
 * delivery.
 */
export function createRunDeliveryDecisionsListHandler(secret: string) {
  return async (
    context: ActionContext,
    input: CursorQuery,
  ): Promise<DeliveryDecisionPage> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const runId = await assertRunVisible(
      transaction,
      organizationId,
      context.params.id,
    );
    const binding = runBinding(
      "runDeliveryDecisions.list",
      organizationId,
      principalId,
      runId,
    );
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<DeliveryDecisionRow>(
      `select ${DELIVERY_DECISION_COLUMNS}
         from bakery.delivery_decisions
        where organization_id = $1 and run_id = $2
          and (
            $3::integer is null or (ordinal, id) > ($3::integer, $4::uuid)
          )
        order by ordinal asc, id asc
        limit $5`,
      [
        organizationId,
        runId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toDeliveryDecision),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: last.ordinal,
          iteration: 0,
          id: last.id,
        })
        : null,
    } as DeliveryDecisionPage;
  };
}

/**
 * `reviewFindings.list`: the findings one review cycle reported. A finding's
 * `status` is derived here, never stored: it is `open` exactly when its
 * fingerprint is reported by the run's latest review cycle (the highest
 * ordinal), and `resolved` otherwise. A finding of the latest cycle itself is
 * therefore open, and one that a middle cycle repeated but the latest cycle
 * dropped is resolved in every earlier cycle. The cycle must belong to the
 * caller's organization; another organization's cycle reads as missing.
 */
export function createReviewFindingsListHandler(secret: string) {
  return async (
    context: ActionContext,
    input: CursorQuery,
  ): Promise<ReviewFindingPage> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const cycleId = context.params.id;
    if (!cycleId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const cycle = await transaction.query<{ run_id: string }>(
      `select run_id from bakery.review_cycles
        where organization_id = $1 and id = $2`,
      [organizationId, cycleId],
    );
    const owner = cycle.rows[0];
    if (!owner) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const binding: CursorBinding = {
      action: "reviewFindings.list",
      principalId,
      organizationId,
      ordering: REVIEW_FINDING_ORDERING,
      filters: JSON.stringify({ reviewCycleId: cycleId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<ReviewFindingRow>(
      `select finding.id, finding.review_cycle_id, finding.fingerprint,
              finding.severity, finding.path, finding.line, finding.body,
              finding.created_at,
              to_char(
                finding.created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) as cursor_created_at,
              exists (
                select 1
                  from bakery.review_findings latest
                 where latest.organization_id = finding.organization_id
                   and latest.fingerprint = finding.fingerprint
                   and latest.review_cycle_id = (
                     select last_cycle.id
                       from bakery.review_cycles last_cycle
                      where last_cycle.organization_id = finding.organization_id
                        and last_cycle.run_id = $3
                      order by last_cycle.ordinal desc
                      limit 1
                   )
              ) as is_open
         from bakery.review_findings finding
        where finding.organization_id = $1
          and finding.review_cycle_id = $2
          and (
            $4::timestamptz is null or
            (finding.created_at, finding.id) > ($4::timestamptz, $5::uuid)
          )
        order by finding.created_at asc, finding.id asc
        limit $6`,
      [
        organizationId,
        cycleId,
        owner.run_id,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toReviewFinding),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    } as ReviewFindingPage;
  };
}

type PullRequestQuery = z.output<typeof contractSchemas.PullRequestQuery>;
type PullRequestPage = z.output<typeof contractSchemas["Page<PullRequest>"]>;

const PULL_REQUEST_ORDERING = "createdAt:asc,id:asc";

type PullRequestRow = {
  id: string;
  task_id: string;
  repository_id: string;
  run_id: string | null;
  provider_number: number;
  url: string;
  head_sha: string;
  base_sha: string;
  status: string;
  merged_sha: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  target_branch: string;
  cursor_created_at: string;
};

const PULL_REQUEST_STATUSES: readonly string[] = ["open", "merged", "closed"];

/** The `PullRequest` projection. */
function toPullRequest(row: PullRequestRow, mayMerge: boolean) {
  if (!PULL_REQUEST_STATUSES.includes(row.status)) {
    throw new Error("DELIVERY_READ_PULL_REQUEST_INVALID");
  }
  return {
    id: row.id,
    taskId: row.task_id,
    repositoryId: row.repository_id,
    runId: row.run_id,
    providerNumber: row.provider_number,
    url: row.url,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    status: row.status,
    mergedSha: row.merged_sha,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
    mayMerge,
    // The repository practice, served so the page sends it and never picks one.
    mergeMethod: PULL_REQUEST_MERGE_METHOD,
    // The repository's default branch: the merge dispatch merges into it too.
    targetBranch: row.target_branch,
  };
}

/** The merge method Bakery uses: squash, the repository practice. */
export const PULL_REQUEST_MERGE_METHOD = "squash" as const;

/** Whether the caller holds the permission to merge a pull request. */
export function callerMayMerge(context: ActionContext): boolean {
  const actor = (context as Partial<AuthorizedActionContext>).authority;
  if (!actor || !("organizationId" in actor)) return false;
  return effectivePermissions(actor as OrganizationActor).includes(
    "pullRequest:merge",
  );
}

/**
 * `pullRequests.list`: the organization's tracked pull requests, oldest
 * registration first, keyed by creation time and id. Repository, task, run
 * and ticket filters narrow the page and are bound into the cursor; the
 * ticket filter (#69) keeps pull requests of tasks linked to that ticket. Another
 * organization's pull requests never match the `organization_id` predicate,
 * so a foreign filter id reads as an empty page.
 */
export function createPullRequestsListHandler(secret: string) {
  return async (
    context: ActionContext,
    input: PullRequestQuery,
  ): Promise<PullRequestPage> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const filters = {
      repositoryId: input.repositoryId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      externalTicketId: input.externalTicketId ?? null,
    };
    const binding: CursorBinding = {
      action: "pullRequests.list",
      principalId,
      organizationId,
      ordering: PULL_REQUEST_ORDERING,
      filters: JSON.stringify(filters),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<PullRequestRow>(
      `select pr.id, pr.task_id, pr.repository_id, pr.run_id,
              pr.provider_number, pr.url, pr.head_sha, pr.base_sha, pr.status,
              pr.merged_sha, pr.created_at, pr.updated_at, pr.version,
              repository.default_branch as target_branch,
              to_char(
                pr.created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) as cursor_created_at
         from bakery.pull_requests as pr
         join bakery.repositories as repository
           on repository.organization_id = pr.organization_id
          and repository.id = pr.repository_id
        where pr.organization_id = $1
          and ($2::uuid is null or pr.repository_id = $2::uuid)
          and ($3::uuid is null or pr.task_id = $3::uuid)
          and ($4::uuid is null or pr.run_id = $4::uuid)
          and ($7::uuid is null or pr.task_id in (
                select link.task_id from bakery.ticket_task_links as link
                 where link.organization_id = $1
                   and link.external_ticket_id = $7::uuid))
          and (
            $5::timestamptz is null or
            (pr.created_at, pr.id) > ($5::timestamptz, $6::uuid)
          )
        order by pr.created_at asc, pr.id asc
        limit $8`,
      [
        organizationId,
        filters.repositoryId,
        filters.taskId,
        filters.runId,
        position?.createdAt ?? null,
        position?.id ?? null,
        filters.externalTicketId,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => toPullRequest(row, callerMayMerge(context))),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    } as PullRequestPage;
  };
}
