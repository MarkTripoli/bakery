import { useEffect, useId, useState } from "react";
import { focusAfterPaint } from "../../app/focus.ts";
import { useShellViewport } from "../../app/responsive.ts";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { formatDate, formatList, type MessageKey } from "@bakery/i18n";
import {
  countsAsNotPassed,
  limitMinutes,
  nameList,
  needsAttention,
  orderChecks,
  reasonSentence,
  took,
  tryKey,
} from "./check-copy.ts";
import type {
  ApprovalChoice,
  ApprovalState,
  CheckRow,
  DeliveryModel,
  FindingRow,
  MergeView,
  NowCard,
} from "./model.ts";
import type { DecisionPhase } from "./use-approval-decision.ts";
import {
  MERGE_NOTICE_KEYS,
  MERGE_REFUSAL_ABOVE,
  mergeBlockedCopy,
  type MergeCardAction,
  mergeNoChecksCopy,
  mergeReadyCopy,
  mergeStepCopy,
  type MergeTarget,
  mergeWorkingCopy,
} from "./merge-copy.ts";
import type { MergePhase } from "./merge-refusal.ts";

export type DeliveryViewState = "loading" | "error" | "forbidden" | "ready";

export type DeliverySectionViewProps = Readonly<{
  state: DeliveryViewState;
  model: DeliveryModel | null;
  offline: boolean;
  /** When the last read arrived, already formatted, shown while offline. */
  lastUpdated: string | null;
  onRetry: () => void;
  /** Scroll to and focus the task's message box. */
  onTellBakery: () => void;
  onOpenRules: () => void;
  /** Where the person's decision on the approval stands. */
  decisionPhase: DecisionPhase;
  /** Sends the decision; resolves to how it ended (`idle` when accepted). */
  onDecide: (
    choice: ApprovalChoice,
    comment: string,
  ) => Promise<DecisionPhase>;
  /** Reads the approvals again after a failed read. */
  onRetryApprovals: () => void;
  /** Where a request to merge, or to check an unknown merge, stands. */
  mergePhase: MergePhase;
  /** The branch and commit the last merge request named, for its refusal. */
  mergeTarget: MergeTarget | null;
  /** Asks Bakery to merge; resolves to how it ended (`idle` when accepted). */
  onMerge: (view: MergeView) => Promise<MergePhase>;
  /** Reads GitHub again for an unknown merge; it never sends a second merge. */
  onCheckAgain: (pullRequestId: string) => Promise<MergePhase>;
  /** Forgets the last merge notice before a new attempt. */
  onClearMerge: () => void;
}>;

/** The Now card's title takes focus after a decision, so it is announced. */
const NOW_TITLE_ID = "delivery-now-title";
const NOTICE_ID = "delivery-approval-notice";

/** At most this many findings or checks show before "Show all". */
const SHOWN = 5;

type Translate = ReturnType<typeof useI18n>["translate"];

type NowCopy = Readonly<{
  title: string;
  body: string;
  action:
    | "tell"
    | "rules"
    | "decide"
    | "retryApprovals"
    | Exclude<MergeCardAction, null>
    | null;
}>;

function nowCopy(t: Translate, now: NowCard): NowCopy {
  const next = t("tasks.delivery.now.nextStep");
  switch (now.kind) {
    case "checking":
      return {
        title: t("tasks.delivery.now.checking.title"),
        body: t("tasks.delivery.now.checking.body"),
        action: null,
      };
    case "fixing":
      return {
        title: t("tasks.delivery.now.fixing.title", {
          attempt: now.attempt,
          max: now.max,
        }),
        body: t("tasks.delivery.now.fixing.body"),
        action: null,
      };
    case "paused":
      return {
        title: t("tasks.delivery.now.paused.title"),
        body: t("tasks.delivery.now.paused.body"),
        action: null,
      };
    case "clean":
      return {
        title: t("tasks.delivery.now.clean.title"),
        body: t("tasks.delivery.now.clean.body"),
        action: null,
      };
    case "approval":
      return {
        title: t("tasks.delivery.now.approval.title"),
        body: t("tasks.delivery.now.approval.body"),
        action: "decide",
      };
    case "approvalUnknown":
      return {
        title: t("tasks.delivery.now.approvalUnknown.title"),
        body: t("tasks.delivery.now.approvalUnknown.body"),
        action: "retryApprovals",
      };
    case "approved":
      return {
        title: t("tasks.delivery.now.approved.title"),
        body: t("tasks.delivery.now.approved.body"),
        action: null,
      };
    case "mergeReady":
      return mergeReadyCopy(t, now);
    case "mergeNoPermission":
      return {
        title: t("tasks.delivery.now.mergeNoPermission.title"),
        body: t("tasks.delivery.now.mergeNoPermission.body"),
        action: null,
      };
    case "mergeUnknown":
      return {
        title: t("tasks.delivery.now.mergeUnknown.title"),
        body: t("tasks.delivery.now.mergeUnknown.body", { head: now.head }),
        action: "checkAgain",
      };
    case "mergeWorking":
      return mergeWorkingCopy(t);
    case "mergeBlocked":
      return mergeBlockedCopy(t, now);
    case "mergeNoChecks":
      return mergeNoChecksCopy(t, now.head);
    case "mergeRefused":
      return {
        title: t("tasks.delivery.now.mergeRefused.title"),
        body: t("tasks.delivery.now.mergeRefused.body"),
        action: "refused",
      };
    case "mergeMoved":
      return {
        title: t(
          now.tried
            ? "tasks.delivery.now.mergeMoved.title"
            : "tasks.delivery.now.mergeMovedUntried.title",
        ),
        body: t("tasks.delivery.now.mergeMoved.body", {
          approved: now.approved,
          current: now.current,
        }),
        action: null,
      };
    case "changesRequested":
      return {
        title: t("tasks.delivery.now.changesRequested.title"),
        body: t("tasks.delivery.now.changesRequested.body"),
        action: null,
      };
    case "rejected":
      return {
        title: t("tasks.delivery.now.rejected.title"),
        body: t("tasks.delivery.now.rejected.body"),
        action: null,
      };
    case "checksFailed":
      return {
        title: t("tasks.delivery.now.checksFailed.title"),
        body: `${
          t("tasks.delivery.now.checksFailed.body", { count: now.failed })
        } ${next}`,
        action: "tell",
      };
    case "stopped":
      return stoppedCopy(t, now, next);
  }
}

function stoppedCopy(
  t: Translate,
  now: Extract<NowCard, { kind: "stopped" }>,
  next: string,
): NowCopy {
  const tell = (title: string, body: string): NowCopy => ({
    title,
    body: `${body} ${next}`,
    action: "tell",
  });
  switch (now.reason) {
    case "repair_cycles_exhausted":
      return tell(
        t("tasks.delivery.now.stopped.cycles.title"),
        t("tasks.delivery.now.stopped.cycles.body", {
          max: now.max,
          count: now.blocking,
        }),
      );
    case "repair_time_exhausted":
      return tell(
        t("tasks.delivery.now.stopped.time.title"),
        t("tasks.delivery.now.stopped.remaining", { count: now.blocking }),
      );
    case "repair_budget_exhausted":
      return tell(
        t("tasks.delivery.now.stopped.budget.title"),
        t("tasks.delivery.now.stopped.remaining", { count: now.blocking }),
      );
    case "repeated_blocker":
      return tell(
        t("tasks.delivery.now.stopped.repeated.title"),
        now.findingTitle === null
          ? t("tasks.delivery.now.stopped.repeated.bodyUnnamed")
          : t("tasks.delivery.now.stopped.repeated.body", {
            title: now.findingTitle,
          }),
      );
    case "checks_unavailable":
      return tell(
        t("tasks.delivery.now.stopped.checks.title"),
        t("tasks.delivery.now.stopped.checks.body", {
          count: now.unavailableChecks,
        }),
      );
    case "reviewer_unavailable":
    case "review_failed":
      return tell(
        t("tasks.delivery.now.stopped.review.title"),
        t("tasks.delivery.now.stopped.review.body"),
      );
    case "policy_missing":
      return {
        title: t("tasks.delivery.now.stopped.policy.title"),
        body: t("tasks.delivery.now.stopped.policy.body"),
        action: "rules",
      };
    case "stale_evidence":
      return {
        title: t("tasks.delivery.now.checking.title"),
        body: t("tasks.delivery.now.checking.body"),
        action: null,
      };
  }
}

/**
 * The Now card's tone says whose turn it is: success when nothing is waiting,
 * information while Bakery is working, warning when it is the person's turn.
 */
function nowTone(now: NowCard): "success" | "information" | "warning" {
  switch (now.kind) {
    case "clean":
    case "approved":
      return "success";
    case "checking":
    case "fixing":
    case "changesRequested":
    case "rejected":
    case "mergeUnknown":
    case "mergeWorking":
      return "information";
    case "mergeBlocked":
    case "mergeNoChecks":
    case "mergeReady":
    case "mergeNoPermission":
    case "mergeRefused":
    case "mergeMoved":
    case "approval":
    case "approvalUnknown":
    case "paused":
    case "checksFailed":
    case "stopped":
      return "warning";
  }
}

/** The Approval step's mark and word for each state of the approval. */
const APPROVAL_STEP: Readonly<
  Record<
    ApprovalState,
    Readonly<{
      status: "waiting" | "done" | "failed" | "unknown";
      label: MessageKey | null;
    }>
  >
> = {
  waiting: { status: "waiting", label: null },
  approved: {
    status: "done",
    label: "tasks.delivery.approval.status.approved",
  },
  changesRequested: {
    status: "failed",
    label: "tasks.delivery.approval.status.changesRequested",
  },
  rejected: {
    status: "failed",
    label: "tasks.delivery.approval.status.rejected",
  },
  closed: {
    status: "unknown",
    label: "tasks.delivery.approval.status.closed",
  },
};

const CHECK_TONE = {
  passed: "success",
  failed: "danger",
  pending: "neutral",
  unavailable: "warning",
  canceled: "neutral",
} as const;

const CHECK_LABEL: Readonly<Record<CheckRow["result"], MessageKey>> = {
  passed: "tasks.delivery.check.passed",
  failed: "tasks.delivery.check.failed",
  pending: "tasks.delivery.check.running",
  unavailable: "tasks.delivery.check.unavailable",
  canceled: "tasks.delivery.check.canceled",
};

const OLDER_RESULT_LABEL: Readonly<Record<CheckRow["result"], MessageKey>> = {
  passed: "tasks.delivery.olderResult.passed",
  failed: "tasks.delivery.olderResult.failed",
  pending: "tasks.delivery.olderResult.running",
  unavailable: "tasks.delivery.olderResult.unavailable",
  canceled: "tasks.delivery.olderResult.canceled",
};

const SEVERITY_LABEL: Readonly<Record<FindingRow["severity"], MessageKey>> = {
  blocker: "tasks.delivery.severity.blocker",
  major: "tasks.delivery.severity.major",
  minor: "tasks.delivery.severity.minor",
  note: "tasks.delivery.severity.note",
};

const SEVERITY_TONE = {
  blocker: "danger",
  major: "warning",
  minor: "neutral",
  note: "neutral",
} as const;

/** The badge beside "Delivery" once the work is approved, and the tone it takes. */
const AFTER_APPROVAL_TONE = {
  readyToMerge: "warning",
  mergeUnknown: "neutral",
  waitingForMerge: "information",
  merging: "information",
  mergeBlocked: "danger",
  changedAfterApproval: "warning",
  merged: "success",
  notMerged: "warning",
  approved: "neutral",
} as const;

/** A pull request's status in the list of the task's other pull requests. */
const PULL_REQUEST_TONE = {
  open: "information",
  merged: "success",
  closed: "neutral",
} as const;

export function DeliverySectionView(
  {
    decisionPhase,
    lastUpdated,
    mergePhase,
    mergeTarget,
    model,
    offline,
    onCheckAgain,
    onClearMerge,
    onDecide,
    onMerge,
    onOpenRules,
    onRetry,
    onRetryApprovals,
    onTellBakery,
    state,
  }: DeliverySectionViewProps,
) {
  const { translate: t } = useI18n();
  const heading = t("tasks.delivery.heading");
  // The badge is the verdict on the whole trace, so it appears with the group
  // that ends it: never before the work is approved.
  const approved = model?.approval?.state === "approved";
  return (
    <UI.PaneSection
      aria-label={heading}
      data-testid="delivery-section"
      heading="strong"
      title={heading}
      trailing={!approved || model === null ? undefined : (
        <UI.Badge
          data-testid="delivery-outcome-badge"
          tone={AFTER_APPROVAL_TONE[model.afterApproval.badge]}
        >
          {t(
            `tasks.delivery.afterApproval.badge.${
              model.afterApproval.badge === "mergeBlocked"
                ? "notMerged"
                : model.afterApproval.badge
            }` as MessageKey,
          )}
        </UI.Badge>
      )}
    >
      <UI.Stack>
        <UI.Text>{t("tasks.delivery.purpose")}</UI.Text>
        {state === "loading" && (
          <UI.Stack aria-label={t("tasks.delivery.loading")} role="status">
            <UI.Skeleton shape="surface" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )}
        {state === "error" && (
          <UI.ErrorState
            action={
              <UI.Button onClick={onRetry}>
                {t("tasks.delivery.error.retry")}
              </UI.Button>
            }
            description={t("tasks.delivery.error.description")}
            title={t("tasks.delivery.error.title")}
            variant="region"
          />
        )}
        {state === "forbidden" && (
          <UI.AlertBanner tone="information">
            {t("tasks.delivery.forbidden")}
          </UI.AlertBanner>
        )}
        {state === "ready" && model !== null && (
          <ReadyView
            decisionPhase={decisionPhase}
            lastUpdated={lastUpdated}
            mergePhase={mergePhase}
            mergeTarget={mergeTarget}
            model={model}
            offline={offline}
            onCheckAgain={onCheckAgain}
            onClearMerge={onClearMerge}
            onDecide={onDecide}
            onMerge={onMerge}
            onOpenRules={onOpenRules}
            onRetryApprovals={onRetryApprovals}
            onTellBakery={onTellBakery}
          />
        )}
      </UI.Stack>
    </UI.PaneSection>
  );
}

const NOTICE_COPY: Readonly<
  Record<"conflict" | "forbidden" | "error" | "unknown", MessageKey>
> = {
  conflict: "tasks.delivery.approval.conflict",
  forbidden: "tasks.delivery.approval.forbidden",
  error: "tasks.delivery.approval.error",
  unknown: "tasks.delivery.approval.unknown",
};

const MERGE_NOTICE_ID = "delivery-merge-notice";

type ApprovalDialog = "approve" | "changes" | "reject";

/** The contract's limit for a decision's comment, counted as the server does. */
const MAX_NOTE = 4000;

/** Opens a dialog's field only once the dialog really is open. */
const fieldInOpenDialog = (id: string) => () =>
  document.querySelector<HTMLElement>(`dialog[open] [id="${id}"]`);

function ReadyView(
  {
    decisionPhase,
    lastUpdated,
    mergePhase,
    mergeTarget,
    model,
    offline,
    onCheckAgain,
    onClearMerge,
    onDecide,
    onMerge,
    onOpenRules,
    onRetryApprovals,
    onTellBakery,
  }: Readonly<{
    model: DeliveryModel;
    offline: boolean;
    lastUpdated: string | null;
    decisionPhase: DecisionPhase;
    mergePhase: MergePhase;
    mergeTarget: MergeTarget | null;
    onMerge: (view: MergeView) => Promise<MergePhase>;
    onCheckAgain: (pullRequestId: string) => Promise<MergePhase>;
    onClearMerge: () => void;
    onDecide: (
      choice: ApprovalChoice,
      comment: string,
    ) => Promise<DecisionPhase>;
    onOpenRules: () => void;
    onRetryApprovals: () => void;
    onTellBakery: () => void;
  }>,
) {
  const { translate: t } = useI18n();
  const phone = useShellViewport() === "phone";
  const fieldId = useId();
  const changesFieldId = `${fieldId}-changes`;
  const [dialog, setDialog] = useState<ApprovalDialog | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [comment, setComment] = useState("");
  const deciding = decisionPhase === "deciding";
  const copy = nowCopy(t, model.now);
  const head = model.headSha === null ? "" : model.headSha.slice(0, 7);
  const note = comment.trim();
  const tooLong = note.length > MAX_NOTE;
  const waiting = model.approval?.state === "waiting";

  // Someone else decided, or the changes moved: a dialog asking for a decision
  // on an approval that is no longer waiting would only be refused.
  useEffect(() => {
    if (dialog !== null && !deciding && !waiting) {
      setDialog(null);
      setComment("");
    }
  }, [dialog, deciding, waiting]);

  const send = async (choice: ApprovalChoice, text: string) => {
    const outcome = await onDecide(choice, text);
    // A failed send that can be tried again keeps the dialog and its note.
    if (
      outcome === "error" || outcome === "unknown" || outcome === "forbidden"
    ) {
      return;
    }
    setDialog(null);
    setComment("");
    // Closing the dialog returns focus to the button that opened it, and that
    // happens in an effect that can run after the next frames, so this waits
    // until no dialog is open: a refusal's notice then takes focus, else the
    // card's title, which announces the new state.
    focusAfterPaint(() =>
      document.querySelector("dialog[open]") !== null ? null : (
        document.getElementById(NOTICE_ID) ??
          document.getElementById(NOW_TITLE_ID)
      )
    );
  };
  const closeDialog = () => {
    if (!deciding) setDialog(null);
  };
  const merge = model.merge;
  const mergeWorking = mergePhase === "working";
  // The merge moved on (someone else merged, the pull request changed, the
  // outcome became unknown): a dialog asking to merge would only be refused.
  useEffect(() => {
    if (mergeOpen && !mergeWorking && merge?.startable !== true) {
      setMergeOpen(false);
    }
  }, [mergeOpen, mergeWorking, merge?.startable]);
  const openMerge = () => {
    onClearMerge();
    setMergeOpen(true);
  };
  const confirmMerge = async () => {
    if (merge === null) return;
    await onMerge(merge);
    // The dialog closes with the answer, whatever it was; what happened is said
    // once, in the card, where the person looks next.
    setMergeOpen(false);
    focusAfterPaint(() =>
      document.querySelector("dialog[open]") !== null ? null : (
        document.getElementById(MERGE_NOTICE_ID) ??
          document.getElementById(NOW_TITLE_ID)
      )
    );
  };
  const checkAgain = async () => {
    if (merge === null) return;
    await onCheckAgain(merge.pullRequestId);
    focusAfterPaint(() => document.getElementById(NOW_TITLE_ID));
  };
  const openDialog = (next: ApprovalDialog) => {
    setDialog(next);
    // A note is typed straight away, so its field, not the close button, takes focus.
    if (next === "changes") focusAfterPaint(fieldInOpenDialog(changesFieldId));
  };

  const mergeDisabled = offline || mergeWorking;
  const mergeButton = (variant: "primary" | "secondary", again = false) => (
    <UI.Button
      disabled={mergeDisabled}
      key="merge"
      onClick={openMerge}
      variant={variant}
    >
      {t(
        again
          ? "tasks.delivery.merge.again.button"
          : "tasks.delivery.merge.button",
      )}
    </UI.Button>
  );
  const checkAgainButton = (
    <UI.Button
      disabled={mergeDisabled}
      key="checkAgain"
      loading={mergeWorking}
      onClick={() => void checkAgain()}
      variant="primary"
    >
      {t("tasks.delivery.merge.checkAgain.button")}
    </UI.Button>
  );
  const openOnGitHub = merge === null ? null : (
    <UI.Link
      href={merge.url}
      key="openOnGitHub"
      rel="noreferrer"
      target="_blank"
      variant="button"
    >
      {t("tasks.delivery.afterApproval.openOnGitHub")}
      <span aria-hidden="true">↗</span>
    </UI.Link>
  );
  // A person who was refused cannot decide, so the answers go away for them.
  const canDecide = copy.action === "decide" && decisionPhase !== "forbidden";
  const answerDisabled = offline || deciding;
  const approveButton = (
    <UI.Button
      disabled={answerDisabled}
      key="approve"
      onClick={() => openDialog("approve")}
      variant="primary"
    >
      {t("tasks.delivery.approval.approve")}
    </UI.Button>
  );
  const changesButton = (
    <UI.Button
      disabled={answerDisabled}
      key="changes"
      onClick={() => openDialog("changes")}
      variant="outline"
    >
      {t("tasks.delivery.approval.requestChanges")}
    </UI.Button>
  );
  const rejectButton = (
    <UI.Button
      disabled={answerDisabled}
      key="reject"
      onClick={() => openDialog("reject")}
      variant="destructive-outline"
    >
      {t("tasks.delivery.approval.reject")}
    </UI.Button>
  );
  const retryButton = (
    <UI.Button key="retry" onClick={onRetryApprovals} variant="outline">
      {t("core.actions.retry")}
    </UI.Button>
  );
  // The slice-1 buttons (Tell Bakery, Open rules) keep their place on every screen.
  const otherButton = copy.action === "tell" || copy.action === "rules"
    ? (
      <UI.Button
        disabled={offline && copy.action === "tell"}
        onClick={copy.action === "tell" ? onTellBakery : onOpenRules}
        variant={copy.action === "tell" ? "primary" : "text"}
      >
        {t(
          copy.action === "tell"
            ? "tasks.delivery.now.tell"
            : "tasks.delivery.now.openRules",
        )}
      </UI.Button>
    )
    : null;
  // Beside the text where they fit and under it where they do not; on a phone
  // the answers are full width and stacked, with the primary last.
  const action = phone
    ? otherButton
    : copy.action === "merge"
    ? mergeButton("primary")
    : copy.action === "mergeAgain"
    ? mergeButton("primary", true)
    : copy.action === "openOnGitHub"
    ? openOnGitHub
    : copy.action === "checkAgain"
    ? checkAgainButton
    : copy.action === "refused"
    ? (
      <UI.Inline>
        {openOnGitHub}
        {merge?.startable === true ? mergeButton("secondary") : null}
      </UI.Inline>
    )
    : copy.action === "decide"
    ? canDecide
      ? <UI.Inline>{approveButton}{changesButton}{rejectButton}</UI.Inline>
      : null
    : copy.action === "retryApprovals"
    ? retryButton
    : otherButton;
  const phoneActions = !phone
    ? null
    : copy.action === "merge"
    ? [mergeButton("primary")]
    : copy.action === "mergeAgain"
    ? [mergeButton("primary", true)]
    : copy.action === "openOnGitHub"
    ? [openOnGitHub]
    : copy.action === "checkAgain"
    ? [checkAgainButton]
    : copy.action === "refused"
    ? [
      openOnGitHub,
      merge?.startable === true ? mergeButton("secondary") : null,
    ]
    : canDecide
    ? [rejectButton, changesButton, approveButton]
    : copy.action === "retryApprovals"
    ? [retryButton]
    : null;

  const refusal = decisionPhase in NOTICE_COPY
    ? NOTICE_COPY[decisionPhase as keyof typeof NOTICE_COPY]
    : null;
  // A failure that can be tried again is shown inside the open dialog, where
  // the person is; the card's notice shows once the dialog is closed.
  const inDialog = refusal !== null &&
    (decisionPhase === "error" || decisionPhase === "unknown" ||
      decisionPhase === "forbidden");
  const noticeProps = {
    icon: decisionPhase === "error" ? undefined : ("info" as const),
    tone: decisionPhase === "error" ? ("error" as const) : ("neutral" as const),
  };
  const dialogNotice = inDialog
    ? (
      <UI.InlineNotice
        data-testid="delivery-approval-dialog-notice"
        role="alert"
        {...noticeProps}
      >
        {decisionPhase === "unknown"
          ? t("tasks.delivery.approval.unknownInDialog")
          : t(refusal)}
      </UI.InlineNotice>
    )
    : null;
  const confirmDisabled = deciding || offline || decisionPhase === "forbidden";
  // Once the re-read lands on Unknown the card says exactly that, so the
  // notice would only repeat it; on Ready, Refused or Merged it still says
  // why the page changed.
  // A stopped merge that GitHub did not merge says so by itself, after a
  // reload too, until a newer merge replaces it.
  const settledNotMerged = mergePhase === "idle" &&
    merge?.afterNotMerged === true;
  const mergeNotice: MessageKey | null =
    Object.hasOwn(MERGE_NOTICE_KEYS, mergePhase) &&
      !(mergePhase === "noAnswer" && merge?.state === "unknown")
      ? MERGE_NOTICE_KEYS[mergePhase as keyof typeof MERGE_NOTICE_KEYS]
      : settledNotMerged
      ? MERGE_NOTICE_KEYS.notMerged
      : null;
  const mergeNoticeIsError = mergePhase === "error" ||
    mergePhase === "unreachable" || MERGE_REFUSAL_ABOVE.has(mergePhase);
  const mergeNoticeProps = {
    icon: mergeNoticeIsError ? undefined : ("info" as const),
    tone: mergeNoticeIsError ? ("error" as const) : ("neutral" as const),
  };
  // The sentences that name the branch or the commit take them from the
  // request, else from the pull request as it now is.
  const noticeArgs = {
    branch: mergeTarget?.branch ?? merge?.targetBranch ?? "",
    head: mergeTarget?.head ?? merge?.headSha.slice(0, 7) ?? "",
  };
  // A lost answer that left no record at all: the card is back to Ready, so the
  // notice goes above it, where it is read first, and says there is no attempt
  // to look for. Elsewhere it keeps its place under the card.
  const noRecord = mergePhase === "noAnswer" &&
    (merge?.state === "ready" || merge?.state === "noPermission");
  // A refusal that started nothing is told before the card it leaves unchanged.
  const noticeAbove = noRecord || MERGE_REFUSAL_ABOVE.has(mergePhase);
  const mergeNoticeElement = mergeNotice !== null && !mergeOpen
    ? (
      <UI.InlineNotice
        data-testid="delivery-merge-notice"
        id={MERGE_NOTICE_ID}
        role="status"
        tabIndex={-1}
        {...mergeNoticeProps}
      >
        {t(
          noRecord ? "tasks.delivery.merge.notice.noRecord" : mergeNotice,
          noticeArgs,
        )}
      </UI.InlineNotice>
    )
    : null;
  const nowContent = (
    <>
      <UI.Heading id={NOW_TITLE_ID} level="subsection" tabIndex={-1}>
        {copy.title}
      </UI.Heading>
      <UI.Text>{copy.body}</UI.Text>
      {offline && (
        <UI.Text>
          {t("tasks.delivery.offline")}
          {lastUpdated !== null &&
            ` ${t("tasks.delivery.lastUpdated", { time: lastUpdated })}`}
        </UI.Text>
      )}
    </>
  );
  return (
    <>
      {noticeAbove && mergeNoticeElement}
      <UI.AlertBanner
        action={action}
        data-testid="delivery-now"
        tone={nowTone(model.now)}
      >
        {phoneActions === null ? nowContent : (
          // On a phone the answers stack under the text. The heading and text
          // keep their own gap-free group; one compact stack puts the gap
          // above the answers that they have between them. No shared banner
          // style changes.
          <UI.Stack gap="compact">
            <UI.Stack gap="none">{nowContent}</UI.Stack>
            <UI.Stack data-testid="delivery-now-actions" gap="compact">
              {phoneActions}
            </UI.Stack>
          </UI.Stack>
        )}
      </UI.AlertBanner>
      {refusal !== null && dialog === null && (
        // Nothing failed when a decision lost or the answer is unknown, and a
        // refusal is an explanation: all three are information. Only a decision
        // that could not be sent is an error.
        <UI.InlineNotice
          data-testid="delivery-approval-notice"
          id={NOTICE_ID}
          role="status"
          tabIndex={-1}
          {...noticeProps}
        >
          {t(refusal)}
        </UI.InlineNotice>
      )}
      {!noticeAbove && mergeNoticeElement}
      {model.outOfDate && !model.pullRequestMoved && (
        <UI.InlineNotice
          data-testid="delivery-out-of-date"
          icon="refresh"
          tone="neutral"
        >
          <UI.Heading level="subsection">
            {t("tasks.delivery.outOfDate.title")}
          </UI.Heading>
          <UI.Text>{t("tasks.delivery.outOfDate.body")}</UI.Text>
        </UI.InlineNotice>
      )}
      <Steps model={model} />
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            disabled={deciding}
            onClick={closeDialog}
            variant="secondary"
          >
            {t("core.actions.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            disabled={confirmDisabled}
            loading={deciding && dialog === "approve"}
            onClick={() => void send("approve", "")}
            variant="primary"
          >
            {t("tasks.delivery.approval.approveDialog.confirm")}
          </UI.Button>
        }
        onOpenChange={(open) => !open && closeDialog()}
        open={dialog === "approve"}
        state={deciding && dialog === "approve"
          ? "confirming"
          : inDialog && dialog === "approve"
          ? "error"
          : "open"}
        title={t("tasks.delivery.approval.approveDialog.title")}
        variant="security"
      >
        <UI.Text>
          {t("tasks.delivery.approval.approveDialog.body", { head })}
        </UI.Text>
        {dialog === "approve" && dialogNotice}
      </UI.AlertDialog>
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            disabled={mergeWorking}
            onClick={() => !mergeWorking && setMergeOpen(false)}
            variant="secondary"
          >
            {t("core.actions.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            disabled={mergeDisabled || mergePhase === "forbidden"}
            loading={mergeWorking}
            onClick={() => void confirmMerge()}
            variant="primary"
          >
            {t("tasks.delivery.merge.confirm.confirm")}
          </UI.Button>
        }
        onOpenChange={(open) => !open && !mergeWorking && setMergeOpen(false)}
        open={mergeOpen && merge !== null}
        state={mergeWorking ? "confirming" : "open"}
        title={t("tasks.delivery.merge.confirm.title", {
          number: merge?.providerNumber ?? 0,
        })}
        variant="security"
      >
        <UI.Stack gap="compact">
          <UI.Text>
            {t("tasks.delivery.merge.confirm.body", {
              head: merge === null ? "" : merge.headSha.slice(0, 7),
              method: t(
                `tasks.delivery.merge.method.${
                  merge?.method ?? "squash"
                }` as MessageKey,
              ),
            })}
          </UI.Text>
          <UI.Text>{t("tasks.delivery.merge.confirm.changed")}</UI.Text>
          <UI.Text>{t("tasks.delivery.merge.confirm.final")}</UI.Text>
        </UI.Stack>
      </UI.AlertDialog>
      <UI.Dialog
        dismissLabel={t("core.actions.close")}
        onOpenChange={(open) => !open && closeDialog()}
        open={dialog === "changes"}
        state={deciding && dialog === "changes"
          ? "submitting"
          : inDialog && dialog === "changes"
          ? "error"
          : "open"}
        title={t("tasks.delivery.approval.changesDialog.title")}
        variant="form"
      >
        <UI.Stack>
          <UI.Text variant="muted">
            {t("tasks.delivery.approval.changesDialog.intro")}
          </UI.Text>
          <UI.Field
            error={tooLong
              ? t("tasks.delivery.approval.changesDialog.tooLong", {
                count: note.length,
                max: MAX_NOTE,
              })
              : undefined}
            hint={t("tasks.delivery.approval.changesDialog.hint")}
            htmlFor={changesFieldId}
            label={t("tasks.delivery.approval.changesDialog.label")}
            state={tooLong ? "invalid" : "default"}
            variant="textarea"
          >
            <textarea
              aria-invalid={tooLong || undefined}
              aria-required="true"
              id={changesFieldId}
              name="comment"
              onChange={(event) => setComment(event.currentTarget.value)}
              readOnly={deciding}
              required
              rows={4}
              value={comment}
            />
          </UI.Field>
          {dialog === "changes" && dialogNotice}
          <UI.Inline>
            <UI.Button
              disabled={deciding}
              onClick={closeDialog}
              variant="secondary"
            >
              {t("core.actions.cancel")}
            </UI.Button>
            <UI.Button
              disabled={confirmDisabled || note === "" || tooLong}
              loading={deciding && dialog === "changes"}
              onClick={() => void send("request_changes", note)}
              variant="primary"
            >
              {t("tasks.delivery.approval.changesDialog.send")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </UI.Dialog>
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            disabled={deciding}
            onClick={closeDialog}
            variant="secondary"
          >
            {t("core.actions.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            disabled={confirmDisabled}
            loading={deciding && dialog === "reject"}
            onClick={() => void send("reject", "")}
            variant="destructive"
          >
            {t("tasks.delivery.approval.rejectDialog.confirm")}
          </UI.Button>
        }
        onOpenChange={(open) => !open && closeDialog()}
        open={dialog === "reject"}
        state={deciding && dialog === "reject"
          ? "confirming"
          : inDialog && dialog === "reject"
          ? "error"
          : "open"}
        title={t("tasks.delivery.approval.rejectDialog.title")}
        variant="destructive"
      >
        <UI.Text>{t("tasks.delivery.approval.rejectDialog.body")}</UI.Text>
        {dialog === "reject" && dialogNotice}
      </UI.AlertDialog>
    </>
  );
}

/** One check: its name and result, then why, how long it took and where its output is. */
function CheckLine({ row }: Readonly<{ row: CheckRow }>) {
  const { translate: t } = useI18n();
  const sentence = reasonSentence(row);
  const time = took(row);
  return (
    <UI.StackedRow
      data-testid="delivery-check-row"
      flush
      role="listitem"
      status={row.olderSha === null
        ? (
          <UI.Badge tone={CHECK_TONE[row.result]}>
            {t(CHECK_LABEL[row.result])}
          </UI.Badge>
        )
        : (
          <UI.Badge>
            {t(OLDER_RESULT_LABEL[row.result], { sha: row.olderSha })}
          </UI.Badge>
        )}
      title={<UI.DataText fit>{row.name}</UI.DataText>}
      titleLines="wrap"
    >
      {sentence !== null && (
        <UI.Text>
          {t(sentence.key, sentence.values)}
          {countsAsNotPassed(row)
            ? ` ${t("tasks.delivery.check.countsAsNotPassed")}`
            : ""}
        </UI.Text>
      )}
      {/* A rule has no time; its sentence already says it is a rule. */}
      {row.rule
        ? sentence === null && (
          <UI.Text>{t("tasks.delivery.check.rule")}</UI.Text>
        )
        : time !== null && (
          <UI.Text>
            {t(
              time.key,
              "values" in time ? time.values : undefined,
            )}
          </UI.Text>
        )}
      {row.evidenceVersionId !== null && (
        <UI.Link href={`/files/versions/${row.evidenceVersionId}`}>
          {t("tasks.delivery.check.openOutput")}
        </UI.Link>
      )}
    </UI.StackedRow>
  );
}

/** Every check with its reason, opened in place under the line it explains. */
function CheckDetails(
  { onToggle, open, rows }: Readonly<{
    rows: readonly CheckRow[];
    open: boolean;
    onToggle: () => void;
  }>,
) {
  const { translate: t } = useI18n();
  const listId = useId();
  return (
    <UI.Stack data-testid="delivery-checks-detail" gap="compact">
      <UI.Button
        aria-controls={listId}
        aria-expanded={open}
        onClick={onToggle}
        variant="text"
      >
        {t(
          open ? "tasks.delivery.checks.hide" : "tasks.delivery.checks.show",
          { count: rows.length },
        )}
      </UI.Button>
      {open && (
        <UI.Stack gap="compact" id={listId} role="list">
          {orderChecks(rows).map((row) => <CheckLine key={row.id} row={row} />)}
        </UI.Stack>
      )}
    </UI.Stack>
  );
}

/** What Bakery tried to fix, newest first, and what bounds it. */
function TryDetails(
  { fixing, onToggle, open }: Readonly<{
    fixing: NonNullable<DeliveryModel["fixing"]>;
    open: boolean;
    onToggle: () => void;
  }>,
) {
  const { locale, translate: t } = useI18n();
  const listId = useId();
  const minutes = limitMinutes(fixing.limits.durationMs);
  const names = (all: readonly string[]) => {
    const { shown, more } = nameList(all);
    const list = formatList(shown, locale);
    return more === 0
      ? list
      : t("tasks.delivery.fixing.tried.andMore", { names: list, count: more });
  };
  return (
    <UI.Stack data-testid="delivery-tries-detail" gap="compact">
      <UI.Button
        aria-controls={listId}
        aria-expanded={open}
        onClick={onToggle}
        variant="text"
      >
        {t(
          open
            ? "tasks.delivery.fixing.tried.hide"
            : "tasks.delivery.fixing.tried.show",
        )}
      </UI.Button>
      {open && (
        <UI.Stack gap="compact" id={listId} role="list">
          {fixing.tries.map((entry) => (
            <UI.StackedRow
              data-testid="delivery-try-row"
              flush
              key={entry.n}
              role="listitem"
              status={
                <UI.Badge>
                  {t(
                    entry.running
                      ? "tasks.delivery.fixing.tried.running"
                      : "tasks.delivery.fixing.tried.finished",
                  )}
                </UI.Badge>
              }
              title={t("tasks.delivery.fixing.tried.try", { n: entry.n })}
            >
              <UI.Text>
                {t(
                  tryKey({
                    checks: entry.checkNames.length,
                    blocking: entry.blocking,
                  }),
                  {
                    checks: entry.checkNames.length,
                    names: names(entry.checkNames),
                    blocking: entry.blocking,
                    sha: entry.sha,
                  },
                )}
              </UI.Text>
            </UI.StackedRow>
          ))}
          <UI.Text variant="caption">
            {minutes === null
              ? t("tasks.delivery.fixing.tried.limitTries", {
                max: fixing.limits.max,
              })
              : t("tasks.delivery.fixing.tried.limit", {
                max: fixing.limits.max,
                minutes,
              })}
          </UI.Text>
        </UI.Stack>
      )}
    </UI.Stack>
  );
}

function Steps({ model }: Readonly<{ model: DeliveryModel }>) {
  const { locale, timeZone, translate: t } = useI18n();
  // Until the person opens or closes a list it follows the facts: the checks
  // open by themselves while any has not passed, the tries while one runs or
  // the loop stopped.
  const [checksToggled, setChecksToggled] = useState<boolean | null>(null);
  const [triesToggled, setTriesToggled] = useState<boolean | null>(null);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copied !== "copied") return;
    const timer = globalThis.setTimeout(() => setCopied("idle"), 2500);
    return () => globalThis.clearTimeout(timer);
  }, [copied]);
  const phone = useShellViewport() === "phone";
  const { checks, review, fixing } = model;
  // The group ends the trace, so it appears once the work is approved and
  // never before (design rule 5).
  const after = model.approval?.state === "approved"
    ? model.afterApproval
    : null;
  const pullRequest = after?.pullRequest ?? null;
  const mergeCommit = pullRequest?.mergedSha ?? null;
  // The Merge step's mark and sentence follow what Bakery recorded.
  const mergeStep = mergeStepCopy(t, {
    merge: model.merge,
    pullRequest,
    mergeCommit,
  });
  // The approval was for the commit the pull request no longer ends at.
  const approvalOlder =
    model.pullRequestMoved && model.merge?.approvedSha != null
      ? model.merge.approvedSha.slice(0, 7)
      : null;
  const copyMergeCommit = async () => {
    if (mergeCommit === null) return;
    try {
      await navigator.clipboard.writeText(mergeCommit);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  const changesSummary = model.headSha === null
    ? t("tasks.delivery.changes.preparing")
    : model.baseSha === null
    ? t("tasks.delivery.changes.summaryNoBase", {
      head: model.headSha.slice(0, 7),
    })
    : t("tasks.delivery.changes.summary", {
      head: model.headSha.slice(0, 7),
      base: model.baseSha.slice(0, 7),
    });

  const failedAny = checks.failed > 0;
  const olderRows = checks.rows.filter((row) => row.olderSha !== null);
  const headShort = model.headSha === null ? null : model.headSha.slice(0, 7);
  const checksStatus = failedAny
    ? "failed"
    : checks.running > 0 || (checks.rows.length > 0 && olderRows.length > 0)
    ? "running"
    : checks.unavailable > 0
    ? "unknown"
    : checks.total > 0 && checks.passed === checks.total
    ? "done"
    : "upcoming";
  const checksOpen = checksToggled ?? needsAttention(checks.rows);
  const triesOpen = triesToggled ?? (fixing !== null &&
    (fixing.running || fixing.stopped));

  const reviewStatus = review === null
    ? "upcoming"
    : review.status === "approved"
    ? review.olderSha === null ? "done" : "running"
    : review.status === "running"
    ? "running"
    : "failed";
  const findings = review?.findings ?? [];
  const shownFindings = showAllFindings ? findings : findings.slice(0, SHOWN);

  const label = (status: string) =>
    t(`tasks.delivery.status.${status}` as MessageKey);
  const helpTip = (
    key: "checks" | "review" | "fixing" | "approval",
    args?: Record<string, number>,
  ) => (
    <UI.HelpTip label={t(`tasks.delivery.help.${key}.label` as MessageKey)}>
      {t(`tasks.delivery.help.${key}.text` as MessageKey, args)}
    </UI.HelpTip>
  );

  const pullRequestLink = pullRequest === null ? undefined : (
    <UI.Link
      href={pullRequest.url}
      rel="noreferrer"
      target="_blank"
      variant="button"
    >
      {t("tasks.delivery.afterApproval.openOnGitHub")}
      <span aria-hidden="true">↗</span>
    </UI.Link>
  );
  // One control that leads somewhere: the task's other pull requests, newest
  // first, opened in place (design-ux, 2026-11-16).
  const earlierList = after === null || after.others.length === 0
    ? null
    : (
      <UI.Disclosure
        data-testid="delivery-earlier-pull-requests"
        summary={t("tasks.delivery.afterApproval.earlier", {
          count: after.others.length,
        })}
      >
        <UI.Stack gap="compact" role="list">
          {after.others.map((other) => (
            <UI.Inline
              gap="compact"
              key={other.providerNumber}
              role="listitem"
            >
              <UI.Text>
                {t("tasks.delivery.afterApproval.earlierRow", {
                  number: other.providerNumber,
                })}
              </UI.Text>
              <UI.Badge tone={PULL_REQUEST_TONE[other.status]}>
                {t(
                  `tasks.delivery.afterApproval.status.${other.status}` as MessageKey,
                )}
              </UI.Badge>
              <UI.Link
                href={other.url}
                rel="noreferrer"
                target="_blank"
                variant="quiet"
              >
                {t("tasks.delivery.afterApproval.openOnGitHub")}
                <span aria-hidden="true">↗</span>
              </UI.Link>
            </UI.Inline>
          ))}
        </UI.Stack>
      </UI.Disclosure>
    );
  return (
    <>
      <UI.StepList label={t("tasks.delivery.steps")}>
        <UI.StepItem
          status={model.headSha === null ? "running" : "done"}
          statusLabel={label(model.headSha === null ? "running" : "done")}
          summary={changesSummary}
          title={t("tasks.delivery.changes.title")}
        />
        <UI.StepItem
          status={checksStatus}
          statusLabel={label(checksStatus)}
          summary={checks.rows.length === 0
            ? t("tasks.delivery.checks.none")
            : olderRows.length > 0 && headShort !== null
            ? t(
              model.pullRequestMoved
                ? "tasks.delivery.checks.noneForCommit"
                : "tasks.delivery.checks.runningAgain",
              { sha: headShort },
            )
            : failedAny
            ? t("tasks.delivery.checks.failedOf", {
              failed: checks.failed,
              total: checks.total,
            })
            : t("tasks.delivery.checks.passedOf", {
              passed: checks.passed,
              total: checks.total,
            })}
          title={<>{t("tasks.delivery.checks.title")}{helpTip("checks")}</>}
        >
          {checks.rows.length === 0 ? null : (
            <CheckDetails
              onToggle={() => setChecksToggled(!checksOpen)}
              open={checksOpen}
              rows={checks.rows}
            />
          )}
        </UI.StepItem>
        <UI.StepItem
          status={reviewStatus}
          statusLabel={label(reviewStatus)}
          summary={review === null ? t("tasks.delivery.review.none") : (
            <>
              {review.status === "approved"
                ? t("tasks.delivery.review.approved", { count: review.others })
                : review.status === "running"
                ? t("tasks.delivery.review.running")
                : review.status === "failed"
                ? t("tasks.delivery.review.failed")
                : review.others === 0
                ? t("tasks.delivery.review.changesBlockingOnly", {
                  blocking: review.blocking,
                })
                : t("tasks.delivery.review.changes", {
                  blocking: review.blocking,
                  others: review.others,
                })}
              {review.olderSha !== null && (
                <>
                  {" "}
                  <UI.Badge>
                    {t("tasks.delivery.olderCommit", { sha: review.olderSha })}
                  </UI.Badge>
                </>
              )}
            </>
          )}
          title={<>{t("tasks.delivery.review.title")}{helpTip("review")}</>}
        >
          {review?.accepted != null && (
            <UI.InlineNotice
              data-testid="delivery-review-accepted"
              icon="info"
              tone="neutral"
            >
              <UI.Text>
                {review.accepted.by === null
                  ? t("tasks.delivery.review.accepted.title", {
                    date: formatDate(new Date(review.accepted.at), locale, {
                      dateStyle: "medium",
                      timeZone,
                    }),
                  })
                  : t("tasks.delivery.review.accepted.titleBy", {
                    name: review.accepted.by,
                    date: formatDate(new Date(review.accepted.at), locale, {
                      dateStyle: "medium",
                      timeZone,
                    }),
                  })}
              </UI.Text>
              <UI.Text>
                {t("tasks.delivery.review.accepted.reason", {
                  reason: review.accepted.reason,
                })}
              </UI.Text>
            </UI.InlineNotice>
          )}
          {findings.length === 0 ? null : (
            <UI.Stack gap="compact">
              {shownFindings.map((finding) => (
                <UI.Text key={finding.id}>
                  <UI.Badge tone={SEVERITY_TONE[finding.severity]}>
                    {t(SEVERITY_LABEL[finding.severity])}
                  </UI.Badge>{" "}
                  {finding.body}{" "}
                  <UI.DataText variant="code">
                    {finding.line === null
                      ? finding.path
                      : `${finding.path}:${finding.line}`}
                  </UI.DataText>
                </UI.Text>
              ))}
              {!showAllFindings && findings.length > SHOWN && (
                <UI.Button
                  onClick={() => setShowAllFindings(true)}
                  variant="text"
                >
                  {t("tasks.delivery.showAll")}
                </UI.Button>
              )}
            </UI.Stack>
          )}
        </UI.StepItem>
        {fixing !== null && (
          <UI.StepItem
            status={fixing.stopped
              ? "failed"
              : fixing.running
              ? "running"
              : "done"}
            statusLabel={label(
              fixing.stopped ? "failed" : fixing.running ? "running" : "done",
            )}
            summary={fixing.stopped
              ? t("tasks.delivery.fixing.stopped", {
                attempt: fixing.attempt,
                count: fixing.blocking,
              })
              : fixing.running
              ? t("tasks.delivery.fixing.running", {
                attempt: fixing.attempt,
                max: fixing.max,
              })
              : t("tasks.delivery.fixing.done", {
                attempt: fixing.attempt,
                max: fixing.max,
              })}
            title={
              <>
                {t("tasks.delivery.fixing.title")}
                {helpTip("fixing", { max: fixing.max })}
              </>
            }
          >
            <TryDetails
              fixing={fixing}
              onToggle={() => setTriesToggled(!triesOpen)}
              open={triesOpen}
            />
          </UI.StepItem>
        )}
        {model.approval !== null && (
          <UI.StepItem
            data-testid="delivery-approval-step"
            status={approvalOlder === null
              ? APPROVAL_STEP[model.approval.state].status
              : "running"}
            statusLabel={approvalOlder !== null
              ? label("running")
              : APPROVAL_STEP[model.approval.state].label === null
              ? label(APPROVAL_STEP[model.approval.state].status)
              : t(APPROVAL_STEP[model.approval.state].label as MessageKey)}
            summary={approvalOlder === null
              ? t(
                `tasks.delivery.approval.step.${model.approval.state}` as MessageKey,
              )
              : t("tasks.delivery.approval.step.approvedOlder", {
                sha: approvalOlder,
                current: (model.headSha ?? "").slice(0, 7),
              })}
            title={
              <>
                {t("tasks.delivery.approval.title")}
                {helpTip("approval")}
              </>
            }
          />
        )}
        {after !== null && (
          <UI.StepItem
            action={phone && earlierList !== null
              // On a phone the action column comes after the step's detail, so
              // the button and the list are handed over together to keep the
              // design's order: sentence, button, then the list.
              ? (
                // The button keeps its label's width in both states: a column
                // would stretch it to the opened list's width (design-ux, #482).
                <UI.Stack gap="compact">
                  <UI.Inline>{pullRequestLink}</UI.Inline>
                  {earlierList}
                </UI.Stack>
              )
              : pullRequestLink}
            data-testid="delivery-pull-request-step"
            group={t("tasks.delivery.afterApproval.group")}
            status={pullRequest === null
              ? "unknown"
              : pullRequest.status === "closed"
              ? "failed"
              : "done"}
            statusLabel={label(
              pullRequest === null
                ? "unknown"
                : pullRequest.status === "closed"
                ? "failed"
                : "done",
            )}
            summary={pullRequest === null
              ? t("tasks.delivery.afterApproval.pullRequest.none")
              : pullRequest.status === "open"
              ? t("tasks.delivery.afterApproval.pullRequest.open", {
                number: pullRequest.providerNumber,
              })
              : pullRequest.status === "merged"
              ? t("tasks.delivery.afterApproval.pullRequest.merged", {
                number: pullRequest.providerNumber,
              })
              : t("tasks.delivery.afterApproval.pullRequest.closed", {
                number: pullRequest.providerNumber,
              })}
            title={t("tasks.delivery.afterApproval.pullRequest.title")}
          >
            {phone || after.others.length === 0 ? null : earlierList}
          </UI.StepItem>
        )}
        {after !== null && (
          <UI.StepItem
            action={mergeCommit === null ? undefined : (
              <UI.Button
                onClick={() => void copyMergeCommit()}
                type="button"
                variant="secondary"
              >
                {t(
                  copied === "copied"
                    ? "tasks.delivery.afterApproval.merge.copied"
                    : copied === "failed"
                    ? "tasks.delivery.afterApproval.merge.copyFailed"
                    : "tasks.delivery.afterApproval.merge.copy",
                )}
              </UI.Button>
            )}
            data-testid="delivery-merge-step"
            status={mergeStep.status}
            statusLabel={mergeStep.status === "running"
              ? t("tasks.delivery.status.inProgress")
              : label(mergeStep.status)}
            summary={mergeStep.summary}
            title={t("tasks.delivery.afterApproval.merge.title")}
          />
        )}
      </UI.StepList>
      {after === null ? null : (
        <UI.Text variant="muted">
          {t("tasks.delivery.afterApproval.note")}
        </UI.Text>
      )}
    </>
  );
}
