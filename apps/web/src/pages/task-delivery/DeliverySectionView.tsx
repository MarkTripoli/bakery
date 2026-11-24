import { useEffect, useId, useState } from "react";
import { focusAfterPaint } from "../../app/focus.ts";
import { useShellViewport } from "../../app/responsive.ts";
import * as UI from "@bakery/ui";
import { REVIEW_LOOP_LIMITS } from "@bakery/contracts/review-evidence";
import { knownCommits, ReferenceText } from "../../app/ReferenceText.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { MessageKey } from "@bakery/i18n";
import { RouterLink } from "../../app/router-link.tsx";
import { DeliveryBody } from "./DeliveryBody.tsx";
import { MoreTriesDialog } from "./MoreTriesDialog.tsx";
import type { MoreTriesPhase } from "./use-more-tries.ts";
import {
  type ApprovalChoice,
  type DeliveryModel,
  type MergeView,
  type NowCard,
} from "./model.ts";
import type { DecisionPhase } from "./use-approval-decision.ts";
import type { GoBackPhase } from "./use-go-back.ts";
import { environmentWord, releaseCopy, releaseTone } from "./release-copy.ts";
import {
  MERGE_NOTICE_KEYS,
  MERGE_REFUSAL_ABOVE,
  mergeBlockedCopy,
  type MergeCardAction,
  mergeNoChecksCopy,
  mergeReadyCopy,
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
  goBackPhase: GoBackPhase;
  onGoBack: (deploymentId: string, reason: string) => Promise<GoBackPhase>;
  onClearGoBack: () => void;
  mayGiveMoreTries: boolean;
  moreTriesPhase: MoreTriesPhase;
  onGiveMoreTries: (tries: number) => Promise<MoreTriesPhase>;
  onClearMoreTries: () => void;
}>;

/** The Now card's title takes focus after a decision, so it is announced. */
const NOW_TITLE_ID = "delivery-now-title";
const NOTICE_ID = "delivery-approval-notice";

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
    | "goBack"
    | "chooseNext"
    | "tellAndMoreTries"
    | null;
}>;

type MoreTriesOffer = "offer" | "ask" | "none";

function nowCopy(
  t: Translate,
  now: Exclude<NowCard, Readonly<{ kind: "paused" }>>,
  context: Readonly<{ model: DeliveryModel; moreTries: MoreTriesOffer }>,
): NowCopy {
  const next = t("tasks.delivery.now.nextStep");
  switch (now.kind) {
    case "checking":
      // Results for an older commit: one sentence here says so, and no second
      // banner repeats it (#57 redesign).
      return context.model.outOfDate
        ? {
          title: t("tasks.delivery.now.checking.stale.title"),
          body: t("tasks.delivery.now.checking.stale.body"),
          action: null,
        }
        : {
          title: t("tasks.delivery.now.checking.title"),
          body: t("tasks.delivery.now.checking.body"),
          action: null,
        };
    case "fixing": {
      // What the running try was asked to fix, when the record says: it is the
      // one place the headline names it, the list of tries gives each try's own.
      const running = context.model.fixing?.tries.find((entry) =>
        entry.running
      );
      const checks = running?.checkNames.length ?? 0;
      const blocking = running?.blocking ?? 0;
      const what = checks > 0 && blocking > 0
        ? t("tasks.delivery.now.fixing.whatBoth", { checks, blocking })
        : checks > 0
        ? t("tasks.delivery.now.fixing.whatChecks", { checks })
        : blocking > 0
        ? t("tasks.delivery.now.fixing.whatFindings", { blocking })
        : null;
      const last = now.attempt >= now.max;
      return {
        title: t("tasks.delivery.now.fixing.title", {
          attempt: now.attempt,
          max: now.max,
        }),
        body: what === null
          ? t(
            last
              ? "tasks.delivery.now.fixing.bodyLast"
              : "tasks.delivery.now.fixing.body",
          )
          : t(
            last
              ? "tasks.delivery.now.fixing.bodyWhatLast"
              : "tasks.delivery.now.fixing.bodyWhat",
            { what },
          ),
        action: null,
      };
    }
    case "clean":
      return {
        title: t("tasks.delivery.now.clean.title"),
        // The title says it; the two settled lines under it say why (#57).
        body: "",
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
    case "release":
      return releaseCopy(t, now);
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
        title: t("tasks.delivery.now.checksFailed.title", {
          count: now.failed,
        }),
        body: `${t("tasks.delivery.now.checksFailed.body")} ${next}`,
        action: "tell",
      };
    case "stopped":
      return stoppedCopy(t, now, next, context.moreTries);
  }
}

function stoppedCopy(
  t: Translate,
  now: Extract<NowCard, { kind: "stopped" }>,
  next: string,
  moreTries: MoreTriesOffer,
): NowCopy {
  // "Nothing was merged." goes after the reason and before what to do next,
  // unless a merge attempt did merge (#62, folded into the #57 redesign).
  const tell = (title: string, body: string): NowCopy => ({
    title,
    body: now.merged
      ? `${body} ${next}`
      : `${body} ${t("tasks.delivery.now.stopped.notMerged")} ${next}`,
    action: "tell",
  });
  switch (now.reason) {
    case "repair_cycles_exhausted": {
      const told = tell(
        t("tasks.delivery.now.stopped.cycles.title"),
        t("tasks.delivery.now.stopped.cycles.body", {
          max: now.max,
          count: now.blocking,
        }),
      );
      return moreTries === "offer"
        ? { ...told, action: "tellAndMoreTries" }
        : moreTries === "ask"
        ? {
          ...told,
          body: `${told.body} ${t("tasks.delivery.now.stopped.askAdmin")}`,
        }
        : {
          ...told,
          body: `${told.body} ${t("tasks.delivery.now.stopped.allUsed")}`,
        };
    }
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
function nowTone(
  now: NowCard,
): "success" | "information" | "warning" | "error" {
  switch (now.kind) {
    case "release":
      return releaseTone(now.status);
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

export function DeliverySectionView(
  {
    decisionPhase,
    lastUpdated,
    mayGiveMoreTries,
    mergePhase,
    mergeTarget,
    model,
    moreTriesPhase,
    offline,
    onCheckAgain,
    goBackPhase,
    onClearGoBack,
    onClearMoreTries,
    onGiveMoreTries,
    onClearMerge,
    onDecide,
    onGoBack,
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
  return (
    <UI.PaneSection
      aria-label={heading}
      data-testid="delivery-section"
      heading="strong"
      title={heading}
    >
      <UI.Stack>
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
            mayGiveMoreTries={mayGiveMoreTries}
            mergePhase={mergePhase}
            mergeTarget={mergeTarget}
            model={model}
            moreTriesPhase={moreTriesPhase}
            onClearMoreTries={onClearMoreTries}
            onGiveMoreTries={onGiveMoreTries}
            offline={offline}
            onCheckAgain={onCheckAgain}
            goBackPhase={goBackPhase}
            onClearGoBack={onClearGoBack}
            onClearMerge={onClearMerge}
            onDecide={onDecide}
            onGoBack={onGoBack}
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
    goBackPhase,
    lastUpdated,
    mayGiveMoreTries,
    mergePhase,
    mergeTarget,
    model,
    moreTriesPhase,
    offline,
    onClearMoreTries,
    onGiveMoreTries,
    onCheckAgain,
    onClearGoBack,
    onClearMerge,
    onDecide,
    onGoBack,
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
    goBackPhase: GoBackPhase;
    onGoBack: (deploymentId: string, reason: string) => Promise<GoBackPhase>;
    onClearGoBack: () => void;
    mayGiveMoreTries: boolean;
    moreTriesPhase: MoreTriesPhase;
    onGiveMoreTries: (tries: number) => Promise<MoreTriesPhase>;
    onClearMoreTries: () => void;
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
  const [goBackOpen, setGoBackOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonMissing, setReasonMissing] = useState(false);
  const reasonId = `${fieldId}-reason`;
  const release = model.release;
  const goingBack = goBackPhase === "working";
  const deciding = decisionPhase === "deciding";
  const triesRoom = model.now.kind === "stopped" &&
      model.now.reason === "repair_cycles_exhausted"
    ? REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling - model.now.max
    : 0;
  const moreTries: MoreTriesOffer = triesRoom < 1
    ? "none"
    : mayGiveMoreTries
    ? "offer"
    : "ask";
  const [moreTriesOpen, setMoreTriesOpen] = useState(false);
  const copy = model.now.kind === "paused"
    ? null
    : nowCopy(t, model.now, { model, moreTries });
  const copyAction = copy?.action ?? null;
  const head = model.headSha === null
    ? ""
    : UI.shortReference("commit", model.headSha);
  const known = knownCommits(model.commits);
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

  const openGoBack = () => {
    onClearGoBack();
    setReason("");
    setReasonMissing(false);
    setGoBackOpen(true);
    focusAfterPaint(fieldInOpenDialog(reasonId));
  };
  const closeGoBack = () => {
    if (goingBack) return;
    setGoBackOpen(false);
    onClearGoBack();
    focusAfterPaint(() => document.getElementById(NOW_TITLE_ID));
  };
  const confirmGoBack = async () => {
    if (release === null) return;
    if (reason.trim() === "") {
      setReasonMissing(true);
      focusAfterPaint(fieldInOpenDialog(reasonId));
      return;
    }
    const outcome = await onGoBack(release.id, reason.trim());
    if (outcome !== "idle") return;
    setGoBackOpen(false);
    setReason("");
    focusAfterPaint(() =>
      document.querySelector("dialog[open]") !== null
        ? null
        : document.getElementById(NOW_TITLE_ID)
    );
  };
  const goBackNotice: MessageKey | null = goBackPhase === "notCurrent"
    ? "tasks.delivery.release.dialog.notCurrent"
    : goBackPhase === "outcomeUnknown"
    ? "tasks.delivery.release.dialog.unknown"
    : goBackPhase === "forbidden"
    ? "tasks.delivery.release.dialog.forbidden"
    : goBackPhase === "noAnswer"
    ? "tasks.delivery.release.dialog.noAnswer"
    : goBackPhase === "error"
    ? "tasks.delivery.release.dialog.error"
    : null;
  const goBackDisabled = offline || goingBack;
  const goBackButton = (variant: "primary" | "outline") => (
    <UI.Button
      disabled={goBackDisabled}
      key="goBack"
      onClick={openGoBack}
      variant={variant}
    >
      {t("tasks.delivery.release.goBack.button")}
    </UI.Button>
  );

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
  const canDecide = copyAction === "decide" && decisionPhase !== "forbidden";
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
  const otherButton = copyAction === "tell" || copyAction === "rules"
    ? (
      <UI.Button
        disabled={offline && copyAction === "tell"}
        onClick={copyAction === "tell" ? onTellBakery : onOpenRules}
        variant={copyAction === "tell" ? "primary" : "text"}
      >
        {t(
          copyAction === "tell"
            ? "tasks.delivery.now.tell"
            : "tasks.delivery.now.openRules",
        )}
      </UI.Button>
    )
    : null;
  const moreTriesButton = (
    <UI.Button
      disabled={offline}
      key="moreTries"
      onClick={() => {
        onClearMoreTries();
        setMoreTriesOpen(true);
      }}
      variant="primary"
    >
      {t("tasks.delivery.moreTries.button")}
    </UI.Button>
  );
  const tellOutlineButton = (
    <UI.Button
      disabled={offline}
      key="tell"
      onClick={onTellBakery}
      variant="outline"
    >
      {t("tasks.delivery.now.tell")}
    </UI.Button>
  );
  const chooseNextLink = (
    <RouterLink
      key="chooseNext"
      search={{ repository: model.repositoryId ?? undefined }}
      to="/issues"
      variant="button"
    >
      {t("tasks.delivery.chooseNext.button")}
    </RouterLink>
  );
  const phoneActions = !phone
    ? null
    : copyAction === "goBack"
    ? [goBackButton("primary")]
    : copyAction === "chooseNext"
    ? [chooseNextLink]
    : copyAction === "tellAndMoreTries"
    ? [tellOutlineButton, moreTriesButton]
    : copyAction === "merge"
    ? [mergeButton("primary")]
    : copyAction === "mergeAgain"
    ? [mergeButton("primary", true)]
    : copyAction === "openOnGitHub"
    ? [openOnGitHub]
    : copyAction === "checkAgain"
    ? [checkAgainButton]
    : copyAction === "refused"
    ? [
      openOnGitHub,
      merge?.startable === true ? mergeButton("secondary") : null,
    ]
    : canDecide
    ? [rejectButton, changesButton, approveButton]
    : copyAction === "retryApprovals"
    ? [retryButton]
    : null;
  // Beside the text where they fit and under it where they do not; on a phone
  // the answers are full width and stacked, with the primary last.
  const action = phone
    ? (phoneActions === null ? otherButton : (
      // In the banner's action slot, so the buttons span the banner, however many.
      <UI.Inline data-testid="delivery-now-actions" gap="compact">
        {phoneActions}
      </UI.Inline>
    ))
    : copyAction === "goBack"
    ? goBackButton("primary")
    : copyAction === "chooseNext"
    ? chooseNextLink
    : copyAction === "tellAndMoreTries"
    ? <UI.Inline>{tellOutlineButton}{moreTriesButton}</UI.Inline>
    : copyAction === "merge"
    ? mergeButton("primary")
    : copyAction === "mergeAgain"
    ? mergeButton("primary", true)
    : copyAction === "openOnGitHub"
    ? openOnGitHub
    : copyAction === "checkAgain"
    ? checkAgainButton
    : copyAction === "refused"
    ? (
      <UI.Inline>
        {openOnGitHub}
        {merge?.startable === true ? mergeButton("secondary") : null}
      </UI.Inline>
    )
    : copyAction === "decide"
    ? canDecide
      ? <UI.Inline>{approveButton}{changesButton}{rejectButton}</UI.Inline>
      : null
    : copyAction === "retryApprovals"
    ? retryButton
    : otherButton;

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
    head: mergeTarget?.head ??
      (merge === null ? "" : UI.shortReference("commit", merge.headSha)),
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
        <ReferenceText
          known={known}
          text={t(
            noRecord ? "tasks.delivery.merge.notice.noRecord" : mergeNotice,
            noticeArgs,
          )}
        />
      </UI.InlineNotice>
    )
    : null;
  const nowContent = copy === null ? null : (
    <>
      <UI.Heading id={NOW_TITLE_ID} level="subsection" tabIndex={-1}>
        {copy.title}
      </UI.Heading>
      {copy.body === "" ? null : (
        <UI.Text>
          <ReferenceText known={known} text={copy.body} />
        </UI.Text>
      )}
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
      {copy === null ? null : (
        <UI.AlertBanner
          action={action}
          actionLayout="stretch"
          data-approval-id={model.approval?.id}
          data-testid="delivery-now"
          tone={nowTone(model.now)}
        >
          {nowContent}
        </UI.AlertBanner>
      )}
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
      <DeliveryBody
        goBackButton={release?.status === "healthy" &&
            release.goBack === "offer"
          ? goBackButton("outline")
          : null}
        model={model}
        onOpenRules={onOpenRules}
      />
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
          <ReferenceText
            known={known}
            text={t("tasks.delivery.approval.approveDialog.body", { head })}
          />
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
            <ReferenceText
              known={known}
              text={t("tasks.delivery.merge.confirm.body", {
                head: merge === null
                  ? ""
                  : UI.shortReference("commit", merge.headSha),
                method: t(
                  `tasks.delivery.merge.method.${
                    merge?.method ?? "squash"
                  }` as MessageKey,
                ),
              })}
            />
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
      {model.now.kind === "stopped" && (
        <MoreTriesDialog
          count={model.now.max}
          max={triesRoom}
          offline={offline}
          onClose={() => {
            setMoreTriesOpen(false);
            onClearMoreTries();
            focusAfterPaint(() => document.getElementById(NOW_TITLE_ID));
          }}
          onGive={onGiveMoreTries}
          open={moreTriesOpen && triesRoom >= 1}
          phase={moreTriesPhase}
        />
      )}
      {goBackOpen && release !== null && (
        <UI.AlertDialog
          cancelAction={
            <UI.Button
              disabled={goingBack}
              onClick={closeGoBack}
              variant="secondary"
            >
              {t("tasks.delivery.release.dialog.keep")}
            </UI.Button>
          }
          confirmAction={
            <UI.Button
              disabled={goBackDisabled}
              loading={goingBack}
              onClick={() => void confirmGoBack()}
              variant="destructive"
            >
              {t("tasks.delivery.release.dialog.confirm")}
            </UI.Button>
          }
          onOpenChange={(open) => !open && closeGoBack()}
          open
          state={goingBack
            ? "confirming"
            : goBackNotice !== null
            ? "error"
            : "open"}
          title={t("tasks.delivery.release.dialog.title")}
          variant="destructive"
        >
          <UI.Stack gap="compact">
            <UI.Text>
              <ReferenceText
                known={known}
                text={release === null ? "" : t(
                  "tasks.delivery.release.dialog.body",
                  {
                    environment: environmentWord(
                      t,
                      release.environment,
                      true,
                    ),
                    commit: release.previousCommitSha === null
                      ? ""
                      : UI.shortReference("commit", release.previousCommitSha),
                  },
                )}
              />
            </UI.Text>
            <UI.Field
              error={reasonMissing
                ? t("tasks.delivery.release.dialog.reason.empty")
                : undefined}
              hint={t("tasks.delivery.release.dialog.reason.help")}
              htmlFor={reasonId}
              label={t("tasks.delivery.release.dialog.reason.label")}
              required
              state={reasonMissing ? "invalid" : "default"}
              variant="textarea"
            >
              <textarea
                aria-invalid={reasonMissing || undefined}
                aria-required="true"
                id={reasonId}
                name="reason"
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                  setReasonMissing(false);
                }}
                readOnly={goingBack}
                required
                rows={3}
                value={reason}
              />
            </UI.Field>
            {goBackNotice === null ? null : (
              <UI.InlineNotice
                data-testid="delivery-go-back-notice"
                role="alert"
                tone="error"
              >
                {t(goBackNotice)}
              </UI.InlineNotice>
            )}
          </UI.Stack>
        </UI.AlertDialog>
      )}
    </>
  );
}
