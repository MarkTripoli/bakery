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

/** Why a check ended as it did: the server's word, as the design's table reads it. */
export type CheckReason =
  | "verified"
  | "exit_nonzero"
  | "signal"
  | "deadline"
  | "output_limit"
  | "rule_violation"
  | "description_placeholder"
  | "tool_missing"
  | "unsupported_checker"
  | "revision_unavailable"
  | "skipped"
  | "metadata_missing"
  | "metadata_too_large"
  | "rule_unbound"
  | "rule_binding_ambiguous"
  | "policy_missing"
  | "awaiting_result"
  | "canceled";

export type DeliveryCheck = Readonly<{
  /** The check run's id, named when a merge is queued on its result. */
  id: string;
  checkId: string;
  checkName: string;
  headSha: string;
  result: CheckResult;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
  /** Why it ended as it did; absent when the server did not say. */
  reason?: CheckReason;
  /** `command` for a command, else the repository rule kind it checks. */
  kind?: string;
  /** The file version that holds the check's output, when one was kept. */
  evidenceVersionId?: string | null;
}>;

export type ReviewStatus =
  | "running"
  | "changes_requested"
  | "approved"
  | "failed";

export type DeliveryReview = Readonly<{
  /** The review cycle's id, named when a merge is queued on its approval. */
  id: string;
  ordinal: number;
  headSha: string;
  /** The repository rules the review judged the candidate under. */
  policyDigest: string;
  status: ReviewStatus;
  findingCount: number;
  blockingCount: number;
  createdAt: string;
  /** Set once a person accepted the review anyway; the server's record. */
  acceptedBy?: string | null;
  /** The accepter's display name, resolved by the server; null when none. */
  acceptedByName?: string | null;
  acceptedAt?: string | null;
  acceptReason?: string | null;
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
  /** The checks a repair was asked to fix, as the decision recorded them. */
  failedChecks?: readonly Readonly<{ checkId: string }>[];
  limits: Readonly<{ maxRepairCycles: number; maxLoopDurationMs?: number }>;
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

/** A pull request as the delivery section reads it, before one is chosen. */
export type DeliveryPullRequest = Readonly<{
  id: string;
  /** The run that opened it, else null when it was registered without one. */
  runId: string | null;
  providerNumber: number;
  url: string;
  status: PullRequestStatus;
  mergedSha: string | null;
  createdAt: string;
  /** The repository the pull request belongs to. */
  repositoryId: string;
  /** The pull request's current head on GitHub, as Bakery last read it. */
  headSha: string;
  /** The branch it merges into, as Bakery last read it. */
  baseSha: string;
  /** The branch this pull request merges into, named in the page's copy. */
  targetBranch: string;
  /** Whether the caller holds the permission to merge it (the server says). */
  mayMerge: boolean;
  /** The merge method Bakery uses; the page sends it and never chooses one. */
  mergeMethod: MergeMethod;
}>;

/** How GitHub combines the commits; the server serves the one to use. */
export type MergeMethod = "merge" | "squash" | "rebase";

/** One merge attempt as the delivery section reads it, newest first. */
export type DeliveryMergeAttempt = Readonly<{
  id: string;
  state: "merged" | "refused" | "unknown";
  /** The head the attempt asked GitHub to merge. */
  expectedHeadSha: string;
  createdAt: string;
  settledAt: string | null;
}>;

/** Where a queued merge stands. Only `blocked` carries a reason. */
export type MergeEntryStatus =
  | "queued"
  | "validating"
  | "merging"
  | "merged"
  | "blocked"
  | "canceled";

/**
 * One queued merge as the delivery section reads it. `blockedReason` is the
 * server's word and may be a reason this page does not know, or null.
 */
export type DeliveryMergeEntry = Readonly<{
  id: string;
  status: MergeEntryStatus;
  blockedReason: string | null;
  /** The head the entry was queued to merge. */
  expectedHeadSha: string;
  createdAt: string;
  /** When the entry last changed: for a stopped merge, when it stopped. */
  updatedAt: string;
}>;

/**
 * Why Bakery stopped a merge that this page has words for. `already_merged`
 * and any reason the page does not know read as no reason at all.
 */
export type MergeBlockedReason =
  | "not_open"
  | "head_moved"
  | "base_moved"
  | "checks_not_passed"
  | "not_permitted"
  | "evidence_changed"
  | "github_refused"
  | "not_merged"
  | "unavailable";

const BLOCKED_REASONS: ReadonlySet<string> = new Set<MergeBlockedReason>([
  "not_open",
  "head_moved",
  "base_moved",
  "checks_not_passed",
  "not_permitted",
  "evidence_changed",
  "github_refused",
  "not_merged",
  "unavailable",
]);

/**
 * What a queued merge names about the candidate: the repository, the base it
 * was checked on, and the run, rules, review and checks that vouch for it. The
 * head and method come from the pull request.
 */
export type MergeRequest = Readonly<{
  repositoryId: string;
  targetBranch: string;
  expectedBaseSha: string;
  runId: string;
  policyDigest: string;
  reviewCycleId: string;
  checkRunIds: readonly string[];
}>;

/**
 * What the person may do about merging, derived only from what the server
 * reported: the pull request, the approval and the newest merge attempt.
 * `unknown` outranks everything: while an attempt's outcome is not known, no
 * merge is offered.
 */
export type MergeView = Readonly<{
  state:
    | "ready"
    | "noPermission"
    | "unknown"
    | "refused"
    | "moved"
    | "working"
    | "blocked"
    | "noChecks";
  pullRequestId: string;
  providerNumber: number;
  url: string;
  /** The branch the pull request merges into. */
  targetBranch: string;
  /** For `working`: where the queued merge stands. */
  stage: "queued" | "validating" | "merging" | null;
  /** For `blocked`: why, when the page knows, else null. */
  blockedReason: MergeBlockedReason | null;
  /** GitHub did not merge it and the merge can be asked for again. */
  afterNotMerged: boolean;
  /** The queued merge was canceled, so the merge can be asked for again. */
  canceled: boolean;
  /** What a new merge names; null when the evidence behind it is missing. */
  request: MergeRequest | null;
  /** A new merge may be started from here, by this person. */
  startable: boolean;
  /** The pull request's head now. */
  headSha: string;
  /** For `moved`: the commit the checks, review and approval were for. */
  approvedSha: string | null;
  /** For `unknown` and `refused`: the head the attempt asked to merge. */
  attemptedSha: string | null;
  method: MergeMethod;
  mayMerge: boolean;
}>;

/** The three statuses `PullRequest.status` carries; there are no others. */
export type PullRequestStatus = "open" | "merged" | "closed";

/**
 * The "After approval" group: the pull request this trace ends at, the merge
 * GitHub confirmed for it, and the section badge that follows from both.
 */
export type AfterApproval = Readonly<{
  /** The pull request shown, else null when the task has none recorded. */
  pullRequest:
    | Readonly<{
      providerNumber: number;
      url: string;
      status: PullRequestStatus;
      /** The merge commit GitHub reported, else null. */
      mergedSha: string | null;
    }>
    | null;
  /** Other pull requests this task has, newest first, listed when asked. */
  others: readonly Readonly<{
    providerNumber: number;
    url: string;
    status: PullRequestStatus;
  }>[];
  badge: AfterApprovalBadge;
}>;

/**
 * `waitingForMerge` while the pull request is open, `merged` only once a merge
 * commit is recorded, `notMerged` when it was closed, else `approved`.
 */
export type AfterApprovalBadge =
  | "readyToMerge"
  | "mergeUnknown"
  | "waitingForMerge"
  | "merging"
  | "mergeBlocked"
  | "changedAfterApproval"
  | "merged"
  | "notMerged"
  | "approved";

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
  /** The run this section is about; selects the pull request it opened. */
  runId: string;
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
  /**
   * The task's pull requests, as `pullRequests.list` returns them (oldest
   * first). Choosing this run's one is the model's job, not the read's.
   */
  pullRequests: readonly DeliveryPullRequest[];
  /** The chosen pull request's merge attempts, newest first. */
  mergeAttempts: readonly DeliveryMergeAttempt[];
  /** The chosen pull request's queued merges, in any order. */
  mergeEntries: readonly DeliveryMergeEntry[];
  /**
   * The chosen pull request is open but its merge attempts or queued merges
   * could not be read. An unknown outcome or a merge under way might be hidden
   * there, so no merge is offered.
   */
  mergeUnavailable: boolean;
  deployments?: readonly DeliveryDeployment[];
  mayDeploy?: boolean;
  paused: boolean;
}>;

export type CheckRow = Readonly<{
  id: string;
  name: string;
  result: CheckResult;
  /** Why it ended as it did, or null when the server did not say. */
  reason: CheckReason | null;
  /** A repository rule rather than a command: it has no run time. */
  rule: boolean;
  /** The file version holding the output, else null. */
  evidenceVersionId: string | null;
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

export type DeploymentStatus =
  | "queued"
  | "deploying"
  | "verifying"
  | "healthy"
  | "degraded"
  | "failed"
  | "unknown"
  | "rolling_back"
  | "rolled_back";

export type DeliveryDeployment = Readonly<{
  id: string;
  environment: string;
  commitSha: string;
  status: DeploymentStatus;
  previousCommitSha: string | null;
  rollbackFailed: boolean;
  createdAt: string;
}>;

export type ReleaseEnvironment = "staging" | "production" | "preview";

export type GoBack = "offer" | "viewer" | "none";

export type ReleaseView = Readonly<{
  id: string;
  environment: ReleaseEnvironment;
  status: DeploymentStatus;
  commitSha: string;
  previousCommitSha: string | null;
  rollbackFailed: boolean;
  goBack: GoBack;
}>;

export type NowCard =
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "fixing"; attempt: number; max: number }>
  | Readonly<{ kind: "paused" }>
  | Readonly<{ kind: "clean" }>
  | Readonly<{ kind: "approval" }>
  | Readonly<{ kind: "approvalUnknown" }>
  | Readonly<{ kind: "approved" }>
  | Readonly<
    { kind: "mergeReady"; head: string; number: number; branch: string }
  >
  | Readonly<{ kind: "mergeNoPermission" }>
  | Readonly<{ kind: "mergeUnknown"; head: string }>
  | Readonly<{ kind: "mergeWorking" }>
  /** Approved, but the reviewed commit has no check results to merge on. */
  | Readonly<{ kind: "mergeNoChecks"; head: string }>
  | Readonly<
    {
      kind: "mergeBlocked";
      /** Null when Bakery was not told why, or the page does not know. */
      reason:
        | Exclude<MergeBlockedReason, "github_refused" | "not_merged">
        | null;
      head: string;
      branch: string;
      mayMerge: boolean;
    }
  >
  | Readonly<{ kind: "mergeRefused"; head: string; mayMerge: boolean }>
  | Readonly<
    { kind: "mergeMoved"; approved: string; current: string; tried: boolean }
  >
  | Readonly<
    {
      kind: "release";
      status: DeploymentStatus;
      environment: ReleaseEnvironment;
      rollbackFailed: boolean;
      goBack: GoBack;
    }
  >
  | Readonly<{ kind: "changesRequested" }>
  | Readonly<{ kind: "rejected" }>
  /** `failed` counts every check that did not pass: failed, could not run or canceled. */
  | Readonly<{ kind: "checksFailed"; failed: number }>
  | Readonly<
    {
      kind: "stopped";
      reason: StopReason;
      max: number;
      blocking: number;
      unavailableChecks: number;
      findingTitle: string | null;
      /** A merge attempt on this pull request merged, so "Nothing was merged." would be false. */
      merged: boolean;
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

/** One repair try, as the decision that started it recorded it. */
export type Try = Readonly<{
  n: number;
  running: boolean;
  /** The checks it was asked to fix, by name, in the order recorded. */
  checkNames: readonly string[];
  /** Blocking findings it was asked to fix. */
  blocking: number;
  sha: string;
}>;

export type DeliveryModel = Readonly<{
  /** False until there are changes to show, so the section is not drawn. */
  visible: boolean;
  headSha: string | null;
  baseSha: string | null;
  outOfDate: boolean;
  /** The results are older only because the pull request now ends elsewhere: nothing is re-running. */
  pullRequestMoved: boolean;
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
      /** A person accepted this review anyway, else null. */
      accepted:
        | Readonly<{ at: string; reason: string; by: string | null }>
        | null;
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
      /** Every repair try, newest first. */
      tries: readonly Try[];
      /** What bounds the loop; the duration is null when the server did not say. */
      limits: Readonly<{ max: number; durationMs: number | null }>;
    } | null
  >;
  /** The approval asked about the latest decision, else null. */
  approval: ApprovalView | null;
  /** The pull request and merge the trace ends at (the design's group). */
  afterApproval: AfterApproval;
  /** What the person may do about merging, else null. */
  merge: MergeView | null;
  now: NowCard;
  release: ReleaseView | null;
  /** Every whole commit id the section may name, so a sentence that shows a short one can draw it as a reference. */
  commits: readonly string[];
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

/** The stops that are about findings a person can accept anyway. */
const FINDING_STOPS: ReadonlySet<string> = new Set<StopReason>([
  "repeated_blocker",
  "repair_cycles_exhausted",
  "repair_time_exhausted",
  "repair_budget_exhausted",
]);

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

/**
 * The pull request the trace ends at: this run's own when the read names one,
 * else the task's most recent (registered without a run), else none. Other
 * pull requests of the task are counted, never listed, and nothing is derived
 * that the read did not report.
 */
export function choosePullRequest(
  pullRequests: readonly DeliveryPullRequest[],
  runId: string,
): DeliveryPullRequest | undefined {
  const ordered = [...pullRequests].sort(byCreatedAt);
  return ordered.filter((entry) => entry.runId === runId).at(-1) ??
    ordered.at(-1);
}

export function afterApproval(
  pullRequests: readonly DeliveryPullRequest[],
  runId: string,
): AfterApproval {
  const ordered = [...pullRequests].sort(byCreatedAt);
  const chosen = choosePullRequest(pullRequests, runId);
  if (chosen === undefined) {
    return { pullRequest: null, others: [], badge: "approved" };
  }
  return {
    pullRequest: {
      providerNumber: chosen.providerNumber,
      url: chosen.url,
      status: chosen.status,
      mergedSha: chosen.mergedSha,
    },
    // Newest first: the list opens from the count, so the most recent thing
    // the person may care about is the first thing they read.
    others: ordered
      .filter((entry) => entry.id !== chosen.id)
      .reverse()
      .map((entry) => ({
        providerNumber: entry.providerNumber,
        url: entry.url,
        status: entry.status,
      })),
    // Never "merged" without the merge commit GitHub reported, and never
    // "merged" for a pull request that was closed instead.
    badge: chosen.status === "open"
      ? "waitingForMerge"
      : chosen.status === "closed"
      ? "notMerged"
      : chosen.mergedSha === null
      ? "approved"
      : "merged",
  };
}

/**
 * What the person may do about merging the chosen pull request. Nothing is
 * worked out that the server did not report.
 *
 * - An attempt whose outcome is unknown outranks everything, except a merge
 *   still being queued or checked: no merge is offered until it is settled, so
 *   the page can never merge twice or say "merged" for a merge Bakery does not
 *   know.
 * - A merge Bakery is working on (queued, checking, merging) is shown as that,
 *   and nothing is offered.
 * - Otherwise a merge needs an explicit approval, results that are current, a
 *   pull request that still ends at the commit that was reviewed, and the
 *   evidence a queued merge names.
 * - The newest stopped or canceled merge shows only while the pull request
 *   still ends at the head it was for and no attempt is newer than it.
 */
export function mergeView(
  {
    pullRequest,
    attempts,
    entries,
    approval,
    outOfDate,
    headSha,
    request,
    unavailable,
  }: Readonly<{
    unavailable: boolean;
    pullRequest: DeliveryPullRequest | undefined;
    attempts: readonly DeliveryMergeAttempt[];
    entries: readonly DeliveryMergeEntry[];
    approval: ApprovalView | null;
    outOfDate: boolean;
    headSha: string | null;
    request: MergeRequest | null;
  }>,
): MergeView | null {
  if (pullRequest === undefined || pullRequest.status !== "open") return null;
  if (unavailable) return null;
  const newest = attempts[0];
  const entry =
    [...entries].sort((a, b) =>
      a.createdAt === b.createdAt
        ? (a.id < b.id ? 1 : -1)
        : a.createdAt < b.createdAt
        ? 1
        : -1
    )[0];
  const base = {
    pullRequestId: pullRequest.id,
    providerNumber: pullRequest.providerNumber,
    url: pullRequest.url,
    targetBranch: pullRequest.targetBranch,
    headSha: pullRequest.headSha,
    method: pullRequest.mergeMethod,
    mayMerge: pullRequest.mayMerge,
    stage: null,
    blockedReason: null,
    afterNotMerged: false,
    canceled: false,
    request,
    startable: false,
  } as const;
  const queuedOrChecking = entry?.status === "queued" ||
    entry?.status === "validating";
  if (newest?.state === "unknown" && !queuedOrChecking) {
    return {
      ...base,
      state: "unknown",
      approvedSha: null,
      attemptedSha: newest.expectedHeadSha,
    };
  }
  if (
    queuedOrChecking || entry?.status === "merging" ||
    // The queue merged it and the pull request read has not caught up yet.
    entry?.status === "merged"
  ) {
    return {
      ...base,
      state: "working",
      stage: entry.status === "queued" || entry.status === "validating"
        ? entry.status
        : "merging",
      approvedSha: null,
      attemptedSha: entry.expectedHeadSha,
    };
  }
  if (approval?.state !== "approved" || outOfDate || headSha === null) {
    return null;
  }
  if (pullRequest.headSha !== headSha) {
    return {
      ...base,
      state: "moved",
      approvedSha: headSha,
      attemptedSha: newest?.expectedHeadSha ?? entry?.expectedHeadSha ?? null,
    };
  }
  // A merge cannot be queued without the evidence it names (the review and the
  // check results of this commit): say so instead of offering nothing.
  if (request === null) {
    return {
      ...base,
      state: "noChecks",
      approvedSha: null,
      attemptedSha: null,
    };
  }
  const mayStart = pullRequest.mayMerge;
  const ready = {
    ...base,
    state: mayStart ? "ready" : "noPermission",
    approvedSha: null,
    attemptedSha: null,
    startable: mayStart,
  } as const;
  const stopped = entry !== undefined &&
      (entry.status === "blocked" || entry.status === "canceled") &&
      entry.expectedHeadSha === pullRequest.headSha &&
      (newest === undefined || newest.createdAt <= entry.updatedAt)
    ? entry
    : undefined;
  if (stopped?.status === "canceled") return { ...ready, canceled: true };
  if (stopped !== undefined) {
    const reason: MergeBlockedReason | null = stopped.blockedReason !== null &&
        BLOCKED_REASONS.has(stopped.blockedReason)
      ? stopped.blockedReason as MergeBlockedReason
      : null;
    if (reason === "not_merged") return { ...ready, afterNotMerged: true };
    if (reason === "github_refused") {
      return {
        ...base,
        state: "refused",
        approvedSha: null,
        attemptedSha: stopped.expectedHeadSha,
        blockedReason: reason,
        startable: mayStart,
      };
    }
    return {
      ...base,
      state: "blocked",
      approvedSha: null,
      attemptedSha: stopped.expectedHeadSha,
      blockedReason: reason,
      startable: mayStart &&
        (reason === "not_permitted" || reason === "unavailable"),
    };
  }
  if (
    newest?.state === "refused" &&
    (entry === undefined || newest.createdAt >= entry.createdAt)
  ) {
    return {
      ...base,
      state: "refused",
      approvedSha: null,
      attemptedSha: newest.expectedHeadSha,
      startable: mayStart,
    };
  }
  return ready;
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
  const evidenceHeadSha = input.revisionHeadSha ??
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
  // The results were current for the commit that was approved. When the pull
  // request now ends somewhere else, that commit is the older one: the
  // results, review and approval are marked as being for an older commit.
  const evidenceOutOfDate = evidenceHeadSha !== null && (
    input.checks.some((check) => check.headSha !== evidenceHeadSha) ||
    input.reviews.some((entry) => entry.headSha !== evidenceHeadSha) ||
    latestDecision?.reason === "stale_evidence"
  );
  const chosenPullRequest = choosePullRequest(input.pullRequests, input.runId);
  const pullRequestMoved = approval?.state === "approved" &&
    !evidenceOutOfDate && evidenceHeadSha !== null &&
    chosenPullRequest?.status === "open" &&
    chosenPullRequest.headSha !== evidenceHeadSha;
  const headSha = pullRequestMoved && chosenPullRequest !== undefined
    ? chosenPullRequest.headSha
    : evidenceHeadSha;
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
    reason: check.reason ?? null,
    rule: check.kind !== undefined && check.kind !== "command",
    evidenceVersionId: check.evidenceVersionId ?? null,
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
    accepted:
      newestReview.acceptedAt != null && newestReview.acceptReason != null
        ? {
          at: newestReview.acceptedAt,
          reason: newestReview.acceptReason,
          by: newestReview.acceptedByName ?? null,
        }
        : null,
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
  const nameOf = new Map(
    [...input.checks].sort(byCreatedAt).map((
      check,
    ) => [check.checkId, check.checkName] as const),
  );
  const repairDecisions = input.decisions.filter((entry) =>
    entry.decision === "repair"
  ).sort((a, b) => a.ordinal - b.ordinal);
  const tries: Try[] = repairDecisions.map((entry, index) => ({
    n: index + 1,
    running: entry.id === latestDecision?.id,
    checkNames: (entry.failedChecks ?? []).map((failed) =>
      nameOf.get(failed.checkId) ?? failed.checkId
    ),
    blocking: entry.blockingFingerprints.length,
    sha: shortSha(entry.headSha),
  })).reverse();
  const fixing = repairs === 0 ? null : {
    attempt: repairs,
    max: maxRepairs,
    running: latestDecision?.decision === "repair",
    stopped,
    blocking: stopped
      ? latestDecision.blockingFingerprints.length || openBlocking
      : openBlocking,
    tries,
    limits: {
      max: maxRepairs,
      durationMs: latestDecision?.limits.maxLoopDurationMs ?? null,
    },
  };

  const mergePullRequest = choosePullRequest(input.pullRequests, input.runId);
  // What a queued merge names: the newest review that judged this exact commit
  // and the newest result of every check on it.
  const mergeReview = newestReview !== undefined &&
      newestReview.headSha === evidenceHeadSha
    ? newestReview
    : undefined;
  const mergeChecks = [...newestByCheck.values()].filter((entry) =>
    entry.headSha === evidenceHeadSha
  );
  const request: MergeRequest | null = mergePullRequest === undefined ||
      mergeReview === undefined || mergeChecks.length === 0
    ? null
    : {
      repositoryId: mergePullRequest.repositoryId,
      targetBranch: mergePullRequest.targetBranch,
      expectedBaseSha: mergePullRequest.baseSha,
      runId: input.runId,
      policyDigest: mergeReview.policyDigest,
      reviewCycleId: mergeReview.id,
      checkRunIds: mergeChecks.map((entry) => entry.id),
    };
  const merge = mergeView({
    pullRequest: mergePullRequest,
    attempts: input.mergeAttempts,
    entries: input.mergeEntries,
    request,
    approval,
    outOfDate: evidenceOutOfDate,
    headSha: evidenceHeadSha,
    unavailable: input.mergeUnavailable,
  });
  const after = afterApproval(input.pullRequests, input.runId);
  const release = releaseView(
    input.deployments ?? [],
    chosenPullRequest?.status === "merged" &&
      chosenPullRequest.mergedSha !== null,
    input.mayDeploy ?? false,
  );
  const commits = [
    ...new Set(
      [
        headSha,
        input.baseSha,
        evidenceHeadSha,
        ...input.checks.map((entry) => entry.headSha),
        ...input.reviews.map((entry) => entry.headSha),
        ...input.decisions.map((entry) => entry.headSha),
        merge?.headSha,
        merge?.approvedSha,
        merge?.attemptedSha,
        after.pullRequest?.mergedSha,
        release?.commitSha,
        release?.previousCommitSha,
      ].filter((sha): sha is string => typeof sha === "string" && sha !== ""),
    ),
  ];
  return {
    commits,
    visible: headSha !== null || input.checks.length > 0 ||
      input.reviews.length > 0,
    headSha,
    baseSha: input.baseSha,
    outOfDate,
    pullRequestMoved,
    checks,
    review,
    fixing,
    approval,
    afterApproval: mergeBadge(after, merge),
    merge,
    now: release === null
      ? mergeNow(
        nowCard({
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
        merge,
        input.paused,
      )
      : {
        kind: "release",
        status: release.status,
        environment: release.environment,
        rollbackFailed: release.rollbackFailed,
        goBack: release.goBack,
      },
    release,
  };
}

const ENVIRONMENTS: readonly ReleaseEnvironment[] = [
  "staging",
  "production",
  "preview",
];

export function releaseView(
  deployments: readonly DeliveryDeployment[],
  merged: boolean,
  mayDeploy: boolean,
): ReleaseView | null {
  if (!merged) return null;
  const newest = [...deployments].sort(byCreatedAt).at(-1);
  if (newest === undefined) return null;
  const environment = ENVIRONMENTS.find((name) => name === newest.environment);
  if (environment === undefined) return null;
  const canRollBack = newest.status === "healthy" ||
    newest.status === "degraded";
  return {
    id: newest.id,
    environment,
    status: newest.status,
    commitSha: newest.commitSha,
    previousCommitSha: newest.previousCommitSha,
    rollbackFailed: newest.rollbackFailed,
    goBack: canRollBack && newest.previousCommitSha !== null
      ? mayDeploy ? "offer" : "viewer"
      : "none",
  };
}

/** The section badge follows the merge state when there is one to act on. */
function mergeBadge(
  after: AfterApproval,
  merge: MergeView | null,
): AfterApproval {
  if (merge === null) return after;
  if (merge.state === "unknown") return { ...after, badge: "mergeUnknown" };
  if (merge.state === "working") return { ...after, badge: "merging" };
  if (merge.state === "noChecks") return { ...after, badge: "approved" };
  // A refused merge is a merge that did not happen, whether it was reached
  // through a stopped queue entry or only through its attempt (an attempt newer
  // than the entry that made it reads the same): both say "Not merged".
  if (merge.state === "blocked" || merge.state === "refused") {
    return { ...after, badge: "mergeBlocked" };
  }
  if (merge.state === "moved") {
    return { ...after, badge: "changedAfterApproval" };
  }
  if (merge.state === "ready" || merge.state === "noPermission") {
    return { ...after, badge: "readyToMerge" };
  }
  return after;
}

/**
 * The Now card, once merging has something to say. An unknown outcome always
 * wins (unless the run is paused, which the card already says). Every other
 * merge state only replaces the plain "approved" card: it never hides a stop,
 * a repair, a failed check or a waiting approval.
 */
function mergeNow(
  base: NowCard,
  merge: MergeView | null,
  paused: boolean,
): NowCard {
  if (merge === null || paused) return base;
  if (merge.state === "unknown") {
    return {
      kind: "mergeUnknown",
      head: shortSha(merge.attemptedSha ?? merge.headSha),
    };
  }
  // Bakery is merging: that is the card, whatever else the run says.
  if (merge.state === "working") return { kind: "mergeWorking" };
  if (base.kind !== "approved") return base;
  switch (merge.state) {
    case "ready":
      return {
        kind: "mergeReady",
        head: shortSha(merge.headSha),
        number: merge.providerNumber,
        branch: merge.targetBranch,
      };
    case "noPermission":
      return { kind: "mergeNoPermission" };
    case "noChecks":
      return { kind: "mergeNoChecks", head: shortSha(merge.headSha) };
    case "refused":
      return {
        kind: "mergeRefused",
        head: shortSha(merge.attemptedSha ?? merge.headSha),
        mayMerge: merge.mayMerge,
      };
    case "moved":
      return {
        kind: "mergeMoved",
        approved: shortSha(merge.approvedSha ?? merge.headSha),
        current: shortSha(merge.headSha),
        tried: merge.attemptedSha !== null,
      };
    case "blocked":
      return {
        kind: "mergeBlocked",
        reason: merge.blockedReason === "github_refused" ||
            merge.blockedReason === "not_merged"
          ? null
          : merge.blockedReason,
        head: shortSha(merge.attemptedSha ?? merge.headSha),
        branch: merge.targetBranch,
        mayMerge: merge.startable,
      };
  }
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
  // A person accepted the review anyway: its blocking findings are accepted,
  // so none of them remains, and a stop for them no longer applies.
  const accepted = review?.accepted != null;
  const blocking = accepted ? [] : open.filter((finding) => finding.blocking);
  if (latestDecision?.decision === "stop") {
    // Stale evidence is not a stop: the card says the results are being checked.
    if (latestDecision.reason === "stale_evidence") return { kind: "checking" };
    if (
      STOP_REASONS.has(latestDecision.reason) &&
      !(accepted && FINDING_STOPS.has(latestDecision.reason))
    ) {
      return {
        kind: "stopped",
        reason: latestDecision.reason as StopReason,
        max: maxRepairs,
        blocking: latestDecision.blockingFingerprints.length ||
          blocking.length,
        unavailableChecks: checks.unavailable,
        findingTitle: blocking[0] ? findingTitle(blocking[0].body) : null,
        merged: input.mergeAttempts.some((attempt) =>
          attempt.state === "merged"
        ),
      };
    }
  }
  if (latestDecision?.decision === "repair" && !accepted) {
    return { kind: "fixing", attempt: repairs, max: maxRepairs };
  }
  if (checks.running > 0 || review === null || review.status === "running") {
    return { kind: "checking" };
  }
  if (review.status === "approved" || accepted) {
    const notPassed = checks.failed + checks.unavailable + checks.canceled;
    if (notPassed > 0) {
      return { kind: "checksFailed", failed: notPassed };
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
