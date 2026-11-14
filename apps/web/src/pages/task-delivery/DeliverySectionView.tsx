import { useEffect, useId, useState } from "react";
import { focusAfterPaint } from "../../app/focus.ts";
import { useShellViewport } from "../../app/responsive.ts";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { MessageKey } from "@bakery/i18n";
import type {
  ApprovalChoice,
  ApprovalState,
  CheckRow,
  DeliveryModel,
  FindingRow,
  NowCard,
} from "./model.ts";
import type { DecisionPhase } from "./use-approval-decision.ts";

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
  action: "tell" | "rules" | "decide" | "retryApprovals" | null;
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
      return "information";
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

export function DeliverySectionView(
  {
    decisionPhase,
    lastUpdated,
    model,
    offline,
    onDecide,
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
            model={model}
            offline={offline}
            onDecide={onDecide}
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
    model,
    offline,
    onDecide,
    onOpenRules,
    onRetryApprovals,
    onTellBakery,
  }: Readonly<{
    model: DeliveryModel;
    offline: boolean;
    lastUpdated: string | null;
    decisionPhase: DecisionPhase;
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
  const openDialog = (next: ApprovalDialog) => {
    setDialog(next);
    // A note is typed straight away, so its field, not the close button, takes focus.
    if (next === "changes") focusAfterPaint(fieldInOpenDialog(changesFieldId));
  };

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
    : copy.action === "decide"
    ? canDecide
      ? <UI.Inline>{approveButton}{changesButton}{rejectButton}</UI.Inline>
      : null
    : copy.action === "retryApprovals"
    ? retryButton
    : otherButton;
  const phoneActions = !phone
    ? null
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
  return (
    <>
      <UI.AlertBanner
        action={action}
        data-testid="delivery-now"
        tone={nowTone(model.now)}
      >
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
        {phoneActions !== null && (
          <UI.Stack data-testid="delivery-now-actions" gap="compact">
            {phoneActions}
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
      {model.outOfDate && (
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

function Steps({ model }: Readonly<{ model: DeliveryModel }>) {
  const { translate: t } = useI18n();
  const [showAllChecks, setShowAllChecks] = useState(false);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const { checks, review, fixing } = model;

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
  const sortedChecks = [...checks.rows].sort((a, b) =>
    Number(b.result === "failed") - Number(a.result === "failed")
  );
  const shownChecks = showAllChecks
    ? sortedChecks
    : sortedChecks.slice(0, SHOWN);

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

  return (
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
          ? t("tasks.delivery.checks.runningAgain", { sha: headShort })
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
        {checksStatus === "done" || checks.rows.length === 0
          ? null
          : (
            <UI.Stack gap="compact">
              {shownChecks.map((row) => (
                <UI.Text key={row.id}>
                  {row.name} {row.olderSha === null
                    ? (
                      <UI.Badge tone={CHECK_TONE[row.result]}>
                        {t(CHECK_LABEL[row.result])}
                      </UI.Badge>
                    )
                    : (
                      <UI.Badge>
                        {t(OLDER_RESULT_LABEL[row.result], {
                          sha: row.olderSha,
                        })}
                      </UI.Badge>
                    )}
                </UI.Text>
              ))}
              {!showAllChecks && sortedChecks.length > SHOWN && (
                <UI.Button
                  onClick={() => setShowAllChecks(true)}
                  variant="text"
                >
                  {t("tasks.delivery.showAll")}
                </UI.Button>
              )}
            </UI.Stack>
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
        />
      )}
      {model.approval !== null && (
        <UI.StepItem
          status={APPROVAL_STEP[model.approval.state].status}
          statusLabel={APPROVAL_STEP[model.approval.state].label === null
            ? label(APPROVAL_STEP[model.approval.state].status)
            : t(APPROVAL_STEP[model.approval.state].label as MessageKey)}
          summary={t(
            `tasks.delivery.approval.step.${model.approval.state}` as MessageKey,
          )}
          title={
            <>
              {t("tasks.delivery.approval.title")}
              {helpTip("approval")}
            </>
          }
        />
      )}
    </UI.StepList>
  );
}
