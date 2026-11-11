import type { CheckKind, CheckReason } from "@bakery/contracts/check-evidence";
import { StandardError } from "@bakery/contracts/http";
import type { RepositoryRuleMode } from "@bakery/contracts/repository-rules";
import {
  assessFreshness,
  type BoundPart,
  type CandidateIdentity,
  type CheckRunEvidence,
  isCoherentEvidence,
} from "./identity.ts";

/**
 * Pure delivery verdict: given what a delivery needs checked and the rows that
 * were recorded, say which requirements hold. Nothing here reads a database or
 * runs a command, so the same rows and the same identity always give the same
 * answer.
 */

/** `STATE_CONFLICT` reason when required checks do not hold. */
export const DELIVERY_CHECKS_BLOCKED_REASON = "delivery_checks_blocked";

/** One check a delivery needs, with how strictly it is enforced. */
export type CheckRequirement = {
  readonly kind: CheckKind;
  /** Fixed policy command id, or the rule key of a metadata check. */
  readonly checkId: string;
  /** `require` blocks, `warn` retains findings, `guide` is ignored. */
  readonly mode: RepositoryRuleMode;
};

/**
 * - `passed`: a fresh, coherent pass.
 * - `failed`: the newest row says the check ran and did not pass.
 * - `unavailable`: the newest row says the check could not be observed (or was
 *   canceled, or contradicts itself).
 * - `stale`: the newest row is a pass bound to an identity that has changed.
 *   Only a pass can be stale; a row that did not pass keeps its own status
 *   whether or not the candidate has moved.
 * - `missing`: there is no concluded evidence (no row, or only a pending one).
 * - `not_blocking`: the requirement is guidance only and was not consulted.
 */
export const REQUIREMENT_STATUSES = Object.freeze(
  [
    "passed",
    "failed",
    "unavailable",
    "stale",
    "missing",
    "not_blocking",
  ] as const,
);
export type RequirementStatus = typeof REQUIREMENT_STATUSES[number];

export type RequirementReason =
  | CheckReason
  | "stale"
  | "no_row"
  | "guide"
  | "row_incoherent";

export type RequirementEvaluation = {
  readonly requirement: CheckRequirement;
  readonly status: RequirementStatus;
  readonly reason: RequirementReason;
  /** True when this requirement keeps the delivery blocked. */
  readonly blocking: boolean;
  /** The row the status came from, or null when there was none. */
  readonly rowId: string | null;
  /** Parts that changed since the row was recorded; empty unless stale. */
  readonly changed: readonly BoundPart[];
};

export type CandidateChecksVerdict = {
  /**
   * True when any `require` requirement is not a fresh pass, and always true
   * when there are no requirements at all (see `reason`).
   */
  readonly blocked: boolean;
  /**
   * `policy_missing` when the delivery named no requirement. An empty list
   * means no policy reached the caller, which is a missing policy, never a
   * delivery with nothing to check. Null otherwise.
   */
  readonly reason: Extract<CheckReason, "policy_missing"> | null;
  readonly evaluations: readonly RequirementEvaluation[];
  /** The blocking evaluations, in requirement order. */
  readonly blockedChecks: readonly RequirementEvaluation[];
};

const rowKey = (kind: CheckKind, checkId: string) => `${kind}\u0000${checkId}`;

/** Higher is stricter; the stricter of two requirements for one check wins. */
const MODE_STRICTNESS: Readonly<Record<RepositoryRuleMode, number>> = Object
  .freeze({ guide: 0, warn: 1, require: 2 });

/**
 * Joins requirement lists into one with a single entry per check, so a check
 * that the fixed policy and a rule both name is judged once. Entries are keyed
 * by kind and check id; a command and a rule that share a name stay separate.
 * The stricter mode wins (`require` over `warn` over `guide`), and the check
 * keeps the position of its first appearance. Inputs are not changed.
 *
 * Callers building a requirement list from several sources (the fixed policy's
 * decisions and `metadataRequirements`, which names the command a bound rule
 * answers) pass it through here: a duplicate would otherwise appear twice in
 * `evaluations`, in `blockedChecks` and in the blocked ids of
 * `delivery_checks_blocked`.
 */
export function mergeRequirements(
  ...lists: ReadonlyArray<readonly CheckRequirement[]>
): CheckRequirement[] {
  const merged: CheckRequirement[] = [];
  const positions = new Map<string, number>();
  for (const requirement of lists.flat()) {
    const key = rowKey(requirement.kind, requirement.checkId);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, merged.length);
      merged.push({ ...requirement });
    } else if (
      MODE_STRICTNESS[requirement.mode] > MODE_STRICTNESS[merged[position].mode]
    ) {
      merged[position] = { ...requirement };
    }
  }
  return merged;
}

/** A row only a coherent pass can favour; anything else sorts as worse. */
function isFavourable(row: CheckRunEvidence): boolean {
  return row.result === "passed" && isCoherentEvidence(row);
}

function timestamp(row: CheckRunEvidence): number {
  const value = Date.parse(row.createdAt);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/**
 * True when `candidate` should replace `current` as the newest row. Later
 * creation wins. Rows recorded at the same instant (one transaction shares a
 * clock) are ordered worst-first: a non-pass is never hidden behind a pass
 * that happens to share its timestamp. Ids only make the order total.
 */
function supersedes(
  candidate: CheckRunEvidence,
  current: CheckRunEvidence,
): boolean {
  const byTime = timestamp(candidate) - timestamp(current);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime > 0;
  if (isFavourable(candidate) !== isFavourable(current)) {
    return isFavourable(current);
  }
  return candidate.id > current.id;
}

/** The newest row per (kind, check id); an older pass never masks a newer failure. */
function newestRows(
  rows: readonly CheckRunEvidence[],
): Map<string, CheckRunEvidence> {
  const newest = new Map<string, CheckRunEvidence>();
  for (const row of rows) {
    const key = rowKey(row.kind, row.checkId);
    const held = newest.get(key);
    if (!held || supersedes(row, held)) newest.set(key, row);
  }
  return newest;
}

function evaluateOne(
  requirement: CheckRequirement,
  row: CheckRunEvidence | undefined,
  current: CandidateIdentity,
): Omit<RequirementEvaluation, "requirement" | "blocking"> {
  if (requirement.mode === "guide") {
    return {
      status: "not_blocking",
      reason: "guide",
      rowId: null,
      changed: [],
    };
  }
  if (!row) {
    return { status: "missing", reason: "no_row", rowId: null, changed: [] };
  }
  if (!isCoherentEvidence(row)) {
    return {
      status: "unavailable",
      reason: "row_incoherent",
      rowId: row.id,
      changed: [],
    };
  }
  if (row.result === "pending") {
    return {
      status: "missing",
      reason: row.reason,
      rowId: row.id,
      changed: [],
    };
  }
  // A row that did not pass reports what it recorded, whether or not the
  // candidate has moved since: it blocks either way, and `failed` and
  // `unavailable` have to stay visible. A row that recorded no digest because
  // its metadata was unavailable must not read as `stale`.
  if (row.result !== "passed") {
    return {
      status: row.result === "failed" ? "failed" : "unavailable",
      reason: row.reason,
      rowId: row.id,
      changed: [],
    };
  }
  const freshness = assessFreshness(row, current);
  if (!freshness.fresh) {
    return {
      status: "stale",
      reason: "stale",
      rowId: row.id,
      changed: freshness.changed,
    };
  }
  return { status: "passed", reason: row.reason, rowId: row.id, changed: [] };
}

/**
 * Judges every requirement against the newest recorded row and the current
 * identity. `require` requirements block unless the newest row is a fresh,
 * coherent `passed`; absence of a row is `missing` and blocks. `warn`
 * requirements report the same status but never block, so their findings are
 * kept. `guide` requirements are not consulted. An empty requirement list is
 * a missing policy and blocks with reason `policy_missing`: no caller may read
 * "nothing was asked" as "everything holds".
 */
export function evaluateCandidateChecks(input: {
  readonly requirements: readonly CheckRequirement[];
  readonly rows: readonly CheckRunEvidence[];
  readonly current: CandidateIdentity;
}): CandidateChecksVerdict {
  if (input.requirements.length === 0) {
    return {
      blocked: true,
      reason: "policy_missing",
      evaluations: [],
      blockedChecks: [],
    };
  }
  const newest = newestRows(input.rows);
  const evaluations = input.requirements.map(
    (requirement): RequirementEvaluation => {
      const outcome = evaluateOne(
        requirement,
        newest.get(rowKey(requirement.kind, requirement.checkId)),
        input.current,
      );
      return {
        requirement,
        ...outcome,
        blocking: requirement.mode === "require" && outcome.status !== "passed",
      };
    },
  );
  const blockedChecks = evaluations.filter(({ blocking }) => blocking);
  return {
    blocked: blockedChecks.length > 0,
    reason: null,
    evaluations,
    blockedChecks,
  };
}

/**
 * Throws `STATE_CONFLICT` with reason `delivery_checks_blocked` and the blocked
 * check ids when any required check does not hold, or when no policy was
 * given (`blockedReason: "policy_missing"`, no ids). Delivery code calls this
 * right before it acts on the candidate.
 */
export function assertCandidateChecksSatisfied(
  verdict: CandidateChecksVerdict,
): void {
  if (!verdict.blocked) return;
  throw new StandardError({
    code: "STATE_CONFLICT",
    params: {
      reason: DELIVERY_CHECKS_BLOCKED_REASON,
      blockedReason: verdict.reason,
      blockedCheckIds: verdict.blockedChecks.map(({ requirement }) =>
        requirement.checkId
      ),
      blocked: verdict.blockedChecks.map((entry) => ({
        kind: entry.requirement.kind,
        checkId: entry.requirement.checkId,
        status: entry.status,
        reason: entry.reason,
      })),
    },
  });
}
