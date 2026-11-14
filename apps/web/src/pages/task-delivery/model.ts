// The delivery section's view model: what the four delivery reads (checks,
// review cycles, review findings, delivery decisions) and the revision's commit
// say, as plain data. No copy and no React, so one unit test proves the rules.
//
// The rules come from the #57 design and its code check:
//  - the run has no head sha of its own: the revision artifact's head sha is the
//    current commit, else the newest check or review row's, else none;
//  - rows for an older commit stay in the lists, are marked and never count
//    toward "passed";
//  - the latest delivery decision (highest ordinal) governs the Now card;
//  - an attempt is a `repair` decision, and the maximum is the latest decision's
//    `limits.maxRepairCycles`;
//  - the person's approval is the run-stage approval asked about the latest
//    delivery decision; an approval about an earlier decision is not shown;
//  - nothing is shown that the server did not report.

export type CheckResult =
  | "pending"
  | "passed"
  | "failed"
  | "unavailable"
  | "canceled";

export type DeliveryCheck = Readonly<{
  id: string;
  checkId: string;
  checkName: string;
  headSha: string;
  result: CheckResult;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
}>;

export type ReviewStatus =
  | "running"
  | "changes_requested"
  | "approved"
  | "failed";

export type DeliveryReview = Readonly<{
  id: string;
  ordinal: number;
  headSha: string;
  status: ReviewStatus;
  findingCount: number;
  blockingCount: number;
  createdAt: string;
}>;

export type FindingSeverity = "blocker" | "major" | "minor" | "note";

export type DeliveryFinding = Readonly<{
  id: string;
  severity: FindingSeverity;
  path: string;
  line: number | null;
  body: string;
  status: "open" | "resolved" | "withdrawn";
}>;

export type StopReason =
  | "policy_missing"
  | "stale_evidence"
  | "checks_unavailable"
  | "repeated_blocker"
  | "repair_cycles_exhausted"
  | "repair_time_exhausted"
  | "repair_budget_exhausted"
  | "reviewer_unavailable"
  | "review_failed";

export type DeliveryDecision = Readonly<{
  id: string;
  ordinal: number;
  decision: "proceed" | "repair" | "stop";
  reason: string;
  headSha: string;
  blockingFingerprints: readonly string[];
  limits: Readonly<{ maxRepairCycles: number }>;
  createdAt: string;
}>;

export type ApprovalStatus =
  | "open"
  | "answered"
  | "expired"
  | "withdrawn"
  | "superseded"
  | "revoked"
  | "consumed";

export type ApprovalChoice = "approve" | "request_changes" | "reject";

/** A run-stage approval as the delivery section reads it. */
export type DeliveryApproval = Readonly<{
  id: string;
  /** The version a decision is bound to (`expectedVersion`). */
  version: number;
  status: ApprovalStatus;
  decision: ApprovalChoice | null;
  /** The delivery decision the approval was asked about. */
  subjectId: string;
  createdAt: string;
}>;

/** An approval row as the API lists it, before it is narrowed to one run. */
export type ListedApproval = Readonly<{
  id: string;
  version: number;
  status: ApprovalStatus;
  decision: string | null;
  subjectType: string;
  subjectId: string;
  scope: unknown;
  createdAt: string;
}>;

const APPROVAL_CHOICES: ReadonlySet<string> = new Set<ApprovalChoice>([
  "approve",
  "request_changes",
  "reject",
]);

/**
 * The run-stage approvals that belong to one run. The projection carries no run
 * id of its own for these, so the run is read from the stage scope the server
 * stored when it asked.
 */
export function approvalsForRun(
  listed: readonly ListedApproval[],
  runId: string,
): DeliveryApproval[] {
  return listed
    .filter((entry) => {
      if (entry.subjectType !== "run_stage") return false;
      const scope = entry.scope;
      return typeof scope === "object" && scope !== null &&
        (scope as { runId?: unknown }).runId === runId;
    })
    .map((entry) => ({
      id: entry.id,
      version: entry.version,
      status: entry.status,
      decision: entry.decision !== null && APPROVAL_CHOICES.has(entry.decision)
        ? entry.decision as ApprovalChoice
        : null,
      subjectId: entry.subjectId,
      createdAt: entry.createdAt,
    }));
}

export type DeliveryInput = Readonly<{
  checks: readonly DeliveryCheck[];
  reviews: readonly DeliveryReview[];
  /** The findings of the latest review cycle, as the server lists them. */
  findings: readonly DeliveryFinding[];
  decisions: readonly DeliveryDecision[];
  /** The run's run-stage approvals, in any order (see `approvalsForRun`). */
  approvals: readonly DeliveryApproval[];
  /** The approvals read failed (other than a refusal), so none may be missing. */
  approvalsUnavailable: boolean;
  /** The revision artifact's head sha, the best source of the current commit. */
  revisionHeadSha: string | null;
  /** The run's base sha (`workspaceBaseSha`, else `baseSha`). */
  baseSha: string | null;
  paused: boolean;
}>;

export type CheckRow = Readonly<{
  id: string;
  name: string;
  result: CheckResult;
  exitCode: number | null;
  durationMs: number | null;
  /** The short sha of the older commit this result belongs to, else null. */
  olderSha: string | null;
}>;

export type FindingRow = Readonly<{
  id: string;
  severity: FindingSeverity;
  blocking: boolean;
  path: string;
  line: number | null;
  body: string;
}>;

export type NowCard =
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "fixing"; attempt: number; max: number }>
  | Readonly<{ kind: "paused" }>
  | Readonly<{ kind: "clean" }>
  | Readonly<{ kind: "approval" }>
  | Readonly<{ kind: "approvalUnknown" }>
  | Readonly<{ kind: "approved" }>
  | Readonly<{ kind: "changesRequested" }>
  | Readonly<{ kind: "rejected" }>
  | Readonly<{ kind: "checksFailed"; failed: number }>
  | Readonly<
    {
      kind: "stopped";
      reason: StopReason;
      max: number;
      blocking: number;
      unavailableChecks: number;
      findingTitle: string | null;
    }
  >;

/**
 * Where the person's approval stands. `closed` is an approval that ended
 * without a decision (it expired or was withdrawn or revoked).
 */
export type ApprovalState =
  | "waiting"
  | "approved"
  | "changesRequested"
  | "rejected"
  | "closed";

export type ApprovalView = Readonly<{
  id: string;
  version: number;
  state: ApprovalState;
}>;

export type DeliveryModel = Readonly<{
  /** False until there are changes to show, so the section is not drawn. */
  visible: boolean;
  headSha: string | null;
  baseSha: string | null;
  outOfDate: boolean;
  checks: Readonly<{
    rows: readonly CheckRow[];
    total: number;
    passed: number;
    failed: number;
    running: number;
    unavailable: number;
    canceled: number;
  }>;
  review: Readonly<
    {
      status: "running" | "approved" | "changesRequested" | "failed";
      olderSha: string | null;
      blocking: number;
      others: number;
      findings: readonly FindingRow[];
    } | null
  >;
  fixing: Readonly<
    {
      attempt: number;
      max: number;
      running: boolean;
      /** The run stopped (a stop reason other than stale evidence). */
      stopped: boolean;
      /** Blocking findings still open, from the stop decision when stopped. */
      blocking: number;
    } | null
  >;
  /** The approval asked about the latest decision, else null. */
  approval: ApprovalView | null;
  now: NowCard;
}>;

const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>([
  "policy_missing",
  "stale_evidence",
  "checks_unavailable",
  "repeated_blocker",
  "repair_cycles_exhausted",
  "repair_time_exhausted",
  "repair_budget_exhausted",
  "reviewer_unavailable",
  "review_failed",
]);

const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  blocker: 0,
  major: 1,
  minor: 2,
  note: 3,
};

const DEFAULT_MAX_REPAIRS = 2;

export const shortSha = (sha: string): string => sha.slice(0, 7);

const byCreatedAt = <T extends { createdAt: string }>(
  left: T,
  right: T,
): number => left.createdAt < right.createdAt ? -1 : 1;

/** The first line of a finding, trimmed, for a sentence that names it. */
export function findingTitle(body: string): string {
  const line = body.split("\n").find((entry) => entry.trim() !== "")?.trim() ??
    "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function approvalState(approval: DeliveryApproval): ApprovalState {
  if (approval.status === "open") return "waiting";
  if (approval.status === "answered" || approval.status === "consumed") {
    return approval.decision === "approve"
      ? "approved"
      : approval.decision === "request_changes"
      ? "changesRequested"
      : approval.decision === "reject"
      ? "rejected"
      : "closed";
  }
  return "closed";
}

export function deliveryModel(input: DeliveryInput): DeliveryModel {
  const newestCheck = [...input.checks].sort(byCreatedAt).at(-1);
  const newestReview = [...input.reviews].sort((a, b) => a.ordinal - b.ordinal)
    .at(-1);
  const headSha = input.revisionHeadSha ??
    [newestCheck, newestReview].filter((row) => row !== undefined)
      .sort(byCreatedAt).at(-1)?.headSha ??
    null;

  const latestDecision = [...input.decisions].sort((a, b) =>
    a.ordinal - b.ordinal
  ).at(-1);
  // Only the approval asked about the latest decision is current; one asked
  // about an earlier decision belongs to a candidate that has been replaced.
  const asked = latestDecision === undefined ? undefined : [...input.approvals]
    .filter((entry) => entry.subjectId === latestDecision.id)
    .sort(byCreatedAt)
    .at(-1);
  const approval: ApprovalView | null = asked === undefined ? null : {
    id: asked.id,
    version: asked.version,
    state: approvalState(asked),
  };
  const maxRepairs = latestDecision?.limits.maxRepairCycles ??
    DEFAULT_MAX_REPAIRS;
  const repairs = input.decisions.filter((entry) => entry.decision === "repair")
    .length;

  // One row per check: its newest result. A result for an older commit is kept,
  // marked, and never counted.
  const newestByCheck = new Map<string, DeliveryCheck>();
  for (const check of [...input.checks].sort(byCreatedAt)) {
    newestByCheck.set(check.checkId, check);
  }
  const rows: CheckRow[] = [...newestByCheck.values()].map((check) => ({
    id: check.id,
    name: check.checkName,
    result: check.result,
    exitCode: check.exitCode,
    durationMs: check.durationMs,
    olderSha: headSha !== null && check.headSha !== headSha
      ? shortSha(check.headSha)
      : null,
  }));
  const counted = rows.filter((row) => row.olderSha === null);
  const count = (result: CheckResult) =>
    counted.filter((row) => row.result === result).length;
  const checks = {
    rows,
    total: counted.length,
    passed: count("passed"),
    failed: count("failed"),
    running: count("pending"),
    unavailable: count("unavailable"),
    canceled: count("canceled"),
  };

  const reviewOlder = newestReview !== undefined && headSha !== null &&
    newestReview.headSha !== headSha;
  const open: FindingRow[] = input.findings
    .filter((finding) => finding.status === "open")
    .map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      blocking: finding.severity === "blocker" || finding.severity === "major",
      path: finding.path,
      line: finding.line,
      body: finding.body,
    }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const reviewStatus = (status: ReviewStatus) =>
    status === "changes_requested" ? "changesRequested" : status;
  const review = newestReview === undefined ? null : {
    status: reviewStatus(newestReview.status),
    olderSha: reviewOlder ? shortSha(newestReview.headSha) : null,
    blocking: newestReview.blockingCount,
    others: Math.max(0, newestReview.findingCount - newestReview.blockingCount),
    findings: open,
  } as const;

  const outOfDate = headSha !== null && (
    input.checks.some((check) => check.headSha !== headSha) ||
    input.reviews.some((entry) => entry.headSha !== headSha) ||
    latestDecision?.reason === "stale_evidence"
  );

  const stopped = latestDecision?.decision === "stop" &&
    latestDecision.reason !== "stale_evidence" &&
    STOP_REASONS.has(latestDecision.reason);
  const openBlocking = open.filter((finding) => finding.blocking).length;
  const fixing = repairs === 0 ? null : {
    attempt: repairs,
    max: maxRepairs,
    running: latestDecision?.decision === "repair",
    stopped,
    blocking: stopped
      ? latestDecision.blockingFingerprints.length || openBlocking
      : openBlocking,
  };

  return {
    visible: headSha !== null || input.checks.length > 0 ||
      input.reviews.length > 0,
    headSha,
    baseSha: input.baseSha,
    outOfDate,
    checks,
    review,
    fixing,
    approval,
    now: nowCard({
      input,
      latestDecision,
      repairs,
      maxRepairs,
      checks,
      review,
      open,
      approval,
      outOfDate,
    }),
  };
}

function nowCard(
  {
    input,
    latestDecision,
    repairs,
    maxRepairs,
    checks,
    review,
    open,
    approval,
    outOfDate,
  }: Readonly<
    {
      input: DeliveryInput;
      latestDecision: DeliveryDecision | undefined;
      repairs: number;
      maxRepairs: number;
      checks: DeliveryModel["checks"];
      review: DeliveryModel["review"];
      open: readonly FindingRow[];
      approval: ApprovalView | null;
      outOfDate: boolean;
    }
  >,
): NowCard {
  if (input.paused) return { kind: "paused" };
  const blocking = open.filter((finding) => finding.blocking);
  if (latestDecision?.decision === "stop") {
    // Stale evidence is the out-of-date notice's job; the card says checking.
    if (latestDecision.reason === "stale_evidence") return { kind: "checking" };
    if (STOP_REASONS.has(latestDecision.reason)) {
      return {
        kind: "stopped",
        reason: latestDecision.reason as StopReason,
        max: maxRepairs,
        blocking: latestDecision.blockingFingerprints.length ||
          blocking.length,
        unavailableChecks: checks.unavailable,
        findingTitle: blocking[0] ? findingTitle(blocking[0].body) : null,
      };
    }
  }
  if (latestDecision?.decision === "repair") {
    return { kind: "fixing", attempt: repairs, max: maxRepairs };
  }
  if (checks.running > 0 || review === null || review.status === "running") {
    return { kind: "checking" };
  }
  if (review.status === "approved") {
    if (checks.failed > 0) {
      return { kind: "checksFailed", failed: checks.failed };
    }
    // Results for an older commit cannot be approved: the notice says so and
    // the card keeps saying the results are being checked.
    if (approval?.state === "waiting") {
      return outOfDate ? { kind: "checking" } : { kind: "approval" };
    }
    if (approval?.state === "approved") return { kind: "approved" };
    if (approval?.state === "changesRequested") {
      return { kind: "changesRequested" };
    }
    if (approval?.state === "rejected") return { kind: "rejected" };
    // An approval may be waiting that could not be read: never say nothing is.
    if (approval === null && input.approvalsUnavailable) {
      return { kind: "approvalUnknown" };
    }
    return { kind: "clean" };
  }
  return { kind: "checking" };
}
