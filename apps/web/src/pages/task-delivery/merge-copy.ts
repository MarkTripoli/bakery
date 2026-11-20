// The words of the merge cards, the Merge step and the refusal notices, as plain
// functions of the model and a translator, so one unit test reads every one of
// them against the English catalog. No React.
import type { MessageKey, Translator } from "@bakery/i18n";
import type { DeliveryModel, MergeBlockedReason, NowCard } from "./model.ts";
import type { MergePhase } from "./merge-refusal.ts";

/**
 * The one primary action of a merge card; never two. `refused` is the built
 * pair (Open on GitHub, then Merge for a reader who may merge).
 */
export type MergeCardAction =
  | "merge"
  | "mergeAgain"
  | "openOnGitHub"
  | "checkAgain"
  | "refused"
  | null;

export type MergeCardCopy = Readonly<{
  title: string;
  body: string;
  action: MergeCardAction;
}>;

/** Approved and ready: Merge is the one action, and the card names the branch. */
export function mergeReadyCopy(
  t: Translator,
  now: Extract<NowCard, { kind: "mergeReady" }>,
): MergeCardCopy {
  return {
    title: t("tasks.delivery.now.mergeReady.title"),
    body: t("tasks.delivery.now.mergeReady.body", {
      head: now.head,
      branch: now.branch,
    }),
    action: "merge",
  };
}

/** Bakery is checking and merging; nothing is for the person to do. */
export function mergeWorkingCopy(t: Translator): MergeCardCopy {
  return {
    title: t("tasks.delivery.now.mergeChecking.title"),
    body: t("tasks.delivery.now.mergeChecking.body"),
    action: null,
  };
}

/**
 * Approved, but the reviewed commit has no check results, so a queued merge
 * would have nothing to name. Never "Ready to merge" with no button: the card
 * says why and sends the person to the pull request's checks.
 */
export function mergeNoChecksCopy(t: Translator, head: string): MergeCardCopy {
  return {
    title: t("tasks.delivery.now.mergeNoChecks.title"),
    body: t("tasks.delivery.now.mergeNoChecks.body", { head }),
    action: "openOnGitHub",
  };
}

/**
 * A stopped merge: what happened, and a button only when pressing it can help.
 * Merge again is for a reader who may merge; a check, a closed pull request or
 * a reason nobody told Bakery sends the person to GitHub.
 */
export function mergeBlockedCopy(
  t: Translator,
  now: Extract<NowCard, { kind: "mergeBlocked" }>,
): MergeCardCopy {
  const args = { branch: now.branch, head: now.head };
  switch (now.reason) {
    case "head_moved":
      return {
        title: t("tasks.delivery.now.mergeMoved.title"),
        body: t("tasks.delivery.now.mergeBlocked.head_moved.body"),
        action: null,
      };
    case "base_moved":
      return {
        title: t("tasks.delivery.now.mergeBlocked.base_moved.title", args),
        body: t("tasks.delivery.now.mergeBlocked.base_moved.body", args),
        action: null,
      };
    case "evidence_changed":
      return {
        title: t("tasks.delivery.now.mergeBlocked.evidence_changed.title"),
        body: t("tasks.delivery.now.mergeBlocked.evidence_changed.body"),
        action: null,
      };
    case "checks_not_passed":
      return {
        title: t("tasks.delivery.now.mergeBlocked.checks_not_passed.title"),
        body: t("tasks.delivery.now.mergeBlocked.checks_not_passed.body", args),
        action: "openOnGitHub",
      };
    case "not_open":
      return {
        title: t("tasks.delivery.now.mergeBlocked.not_open.title"),
        body: t("tasks.delivery.now.mergeBlocked.not_open.body"),
        action: "openOnGitHub",
      };
    case "not_permitted":
      return {
        title: t("tasks.delivery.now.mergeBlocked.not_permitted.title"),
        body: t("tasks.delivery.now.mergeBlocked.not_permitted.body"),
        action: now.mayMerge ? "mergeAgain" : null,
      };
    case "unavailable":
      return {
        title: t("tasks.delivery.now.mergeBlocked.unavailable.title"),
        body: t("tasks.delivery.now.mergeBlocked.unavailable.body"),
        action: now.mayMerge ? "mergeAgain" : null,
      };
    case null:
      return {
        title: t("tasks.delivery.now.mergeBlocked.unknown.title"),
        body: t("tasks.delivery.now.mergeBlocked.unknown.body"),
        action: "openOnGitHub",
      };
  }
}

/** One status the Merge step can show. */
export type MergeStepStatus =
  | "done"
  | "failed"
  | "unknown"
  | "upcoming"
  | "running";

export type MergeStepCopy = Readonly<{
  status: MergeStepStatus;
  summary: string;
}>;

/** What the Merge step's sentence says for a stopped merge, by reason. */
const BLOCKED_STEP: Readonly<
  Record<
    Exclude<MergeBlockedReason, "head_moved" | "github_refused">,
    MessageKey
  >
> = {
  base_moved: "tasks.delivery.afterApproval.merge.blocked.base_moved",
  evidence_changed:
    "tasks.delivery.afterApproval.merge.blocked.evidence_changed",
  checks_not_passed:
    "tasks.delivery.afterApproval.merge.blocked.checks_not_passed",
  not_open: "tasks.delivery.afterApproval.merge.blocked.not_open",
  not_permitted: "tasks.delivery.afterApproval.merge.blocked.not_permitted",
  not_merged: "tasks.delivery.afterApproval.merge.blocked.not_merged",
  unavailable: "tasks.delivery.afterApproval.merge.blocked.unavailable",
};

/**
 * The Merge step's mark and sentence. Done only with the merge commit GitHub
 * reported; Bakery working is in progress; a refused, moved or stopped merge is
 * failed with the short cause; an unknown outcome or a pull request Bakery
 * cannot place is unknown; otherwise it simply has not happened yet.
 */
export function mergeStepCopy(
  t: Translator,
  {
    merge,
    pullRequest,
    mergeCommit,
  }: Readonly<{
    merge: DeliveryModel["merge"];
    pullRequest: Readonly<{ status: "open" | "merged" | "closed" }> | null;
    mergeCommit: string | null;
  }>,
): MergeStepCopy {
  if (mergeCommit !== null) {
    return {
      status: "done",
      summary: t("tasks.delivery.afterApproval.merge.merged", {
        commit: mergeCommit.slice(0, 7),
      }),
    };
  }
  if (merge?.state === "working") {
    return {
      status: "running",
      summary: merge.stage === "merging"
        ? t("tasks.delivery.afterApproval.merge.merging", {
          branch: merge.targetBranch,
        })
        : t(
          merge.stage === "queued"
            ? "tasks.delivery.afterApproval.merge.queued"
            : "tasks.delivery.afterApproval.merge.validating",
        ),
    };
  }
  if (merge?.state === "refused") {
    return {
      status: "failed",
      summary: t("tasks.delivery.afterApproval.merge.refused"),
    };
  }
  if (merge?.state === "moved" && merge.attemptedSha !== null) {
    return {
      status: "failed",
      summary: t("tasks.delivery.afterApproval.merge.moved"),
    };
  }
  if (merge?.state === "blocked") {
    const reason = merge.blockedReason;
    return {
      status: "failed",
      summary: reason === "head_moved"
        ? t("tasks.delivery.afterApproval.merge.moved")
        : reason === null || reason === "github_refused"
        ? t("tasks.delivery.afterApproval.merge.blocked.unknown")
        : t(BLOCKED_STEP[reason], { branch: merge.targetBranch }),
    };
  }
  if (merge?.afterNotMerged === true) {
    return {
      status: "failed",
      summary: t("tasks.delivery.afterApproval.merge.blocked.not_merged"),
    };
  }
  if (merge?.canceled === true) {
    return {
      status: "failed",
      summary: t("tasks.delivery.afterApproval.merge.canceled"),
    };
  }
  if (
    merge?.state === "unknown" || pullRequest === null ||
    pullRequest.status === "merged"
  ) {
    return {
      status: "unknown",
      summary: t("tasks.delivery.afterApproval.merge.unknown"),
    };
  }
  return pullRequest.status === "open"
    ? {
      status: "upcoming",
      summary: t("tasks.delivery.afterApproval.merge.notYet"),
    }
    : {
      status: "upcoming",
      summary: t("tasks.delivery.afterApproval.merge.notMerged"),
    };
}

/** What a merge request says once it has ended other than by working. */
export const MERGE_NOTICE_KEYS: Readonly<
  Record<Exclude<MergePhase, "idle" | "working">, MessageKey>
> = {
  noAnswer: "tasks.delivery.merge.notice.noAnswer",
  conflict: "tasks.delivery.merge.notice.conflict",
  inProgress: "tasks.delivery.merge.notice.inProgress",
  baseMoved: "tasks.delivery.merge.notice.baseMoved",
  notOpen: "tasks.delivery.merge.notice.notOpen",
  findingsBlocking: "tasks.delivery.merge.notice.findingsBlocking",
  checksNotPassed: "tasks.delivery.merge.notice.checksNotPassed",
  forbidden: "tasks.delivery.merge.notice.forbidden",
  error: "tasks.delivery.merge.notice.error",
  unreachable: "tasks.delivery.merge.notice.unreachable",
  notMerged: "tasks.delivery.merge.notice.notMerged",
};

/**
 * Refusals that start nothing and say why. They show above the card as an
 * error: the person's request did not begin, so the card is unchanged.
 */
export const MERGE_REFUSAL_ABOVE: ReadonlySet<MergePhase> = new Set<
  MergePhase
>([
  "inProgress",
  "baseMoved",
  "notOpen",
  "findingsBlocking",
  "checksNotPassed",
]);

/** The branch and commit a refusal's sentence names. */
export type MergeTarget = Readonly<{ branch: string; head: string }>;
