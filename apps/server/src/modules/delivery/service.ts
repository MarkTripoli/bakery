import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CandidateIdentity,
  type CheckRunEvidence,
  CheckRunEvidenceSchema,
} from "./identity.ts";
import {
  type CandidateChecksVerdict,
  type CheckRequirement,
  evaluateCandidateChecks,
} from "./verdict.ts";

type EvidenceRow = {
  id: string;
  check_id: string;
  kind: string;
  rule_key: string | null;
  result: string;
  reason: string;
  created_at: Date | string;
  head_sha: string;
  base_sha: string | null;
  profile_digest: string | null;
  subject_digest: string;
  checker_digest: string | null;
  title_digest: string | null;
  body_digest: string | null;
  merge_message_digest: string | null;
  commit_selection_digest: string | null;
};

function toEvidence(row: EvidenceRow): CheckRunEvidence {
  return CheckRunEvidenceSchema.parse({
    id: row.id,
    checkId: row.check_id,
    kind: row.kind,
    ruleKey: row.rule_key,
    result: row.result,
    reason: row.reason,
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)).toISOString(),
    headSha: row.head_sha,
    baseSha: row.base_sha,
    profileDigest: row.profile_digest,
    subjectDigest: row.subject_digest,
    checkerDigest: row.checker_digest,
    titleDigest: row.title_digest,
    bodyDigest: row.body_digest,
    mergeMessageDigest: row.merge_message_digest,
    commitSelectionDigest: row.commit_selection_digest,
  });
}

/**
 * The newest recorded row for each requested check of one run, read with an
 * explicit organization predicate: a run of another organization is
 * indistinguishable from a run with no rows. At most one row per (kind, check
 * id) comes back, so re-evaluating a pull request many times cannot grow the
 * read. Ordering mirrors the pure evaluator: latest first, and among rows
 * recorded at the same instant a row that is not a clean pass first, so a
 * non-pass never hides behind a pass that shares its timestamp.
 */
export async function readNewestCheckRuns(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly checkIds: readonly string[];
  },
): Promise<CheckRunEvidence[]> {
  if (input.checkIds.length === 0) return [];
  const result = await transaction.query<EvidenceRow>(
    `select distinct on (kind, check_id)
            id, check_id, kind, rule_key, result, reason, created_at,
            head_sha, base_sha, profile_digest, subject_digest,
            checker_digest, title_digest, body_digest, merge_message_digest,
            commit_selection_digest
       from bakery.check_runs
      where organization_id = $1
        and run_id = $2
        and check_id = any($3::text[])
      order by kind, check_id, created_at desc,
               (result = 'passed' and reason = 'verified') asc, id desc`,
    [input.organizationId, input.runId, [...new Set(input.checkIds)]],
  );
  return result.rows.map(toEvidence);
}

/**
 * Entry point for delivery decisions (merge, review, the checks UI): reads
 * the recorded check rows of one run and judges every requirement against the
 * candidate as it is now. A requirement with no row is `missing` and blocks;
 * an empty requirement list is a missing policy and blocks (`policy_missing`).
 * Rows are evidence only; this never records, edits or runs anything.
 *
 * The review finalizer (`evaluateReviewedChecks` in candidate.ts) is the first
 * production caller: it judges a reviewed candidate with this function before it
 * decides to proceed, repair or stop. The delivery gate
 * (`evaluateDeliveryCandidate`) reads the rows again right before a merge; the
 * merge consumer (#97) is its caller, so only tests call it today.
 */
export async function evaluateDeliveryChecks(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly current: CandidateIdentity;
    readonly requirements: readonly CheckRequirement[];
  },
): Promise<CandidateChecksVerdict> {
  const rows = await readNewestCheckRuns(transaction, {
    organizationId: input.organizationId,
    runId: input.runId,
    checkIds: input.requirements.map(({ checkId }) => checkId),
  });
  return evaluateCandidateChecks({
    requirements: input.requirements,
    rows,
    current: input.current,
  });
}
