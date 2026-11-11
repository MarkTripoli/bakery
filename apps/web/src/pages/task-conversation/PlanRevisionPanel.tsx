import { type ReactNode, useId, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { PlanBody } from "./model.ts";

export type PlanDecision = "approve" | "request_changes" | "reject";
export type PlanPhase =
  | "idle"
  | "deciding"
  | "unknown"
  | "forbidden"
  | "conflict"
  | "error";

export type PlanRevisionPanelProps = Readonly<{
  /** The revision to present; null presents no plan. */
  revision: number | null;
  status:
    | "proposed"
    | "approved"
    | "changes_requested"
    | "rejected"
    | "superseded";
  body: PlanBody;
  /** Approval bound to this exact revision, when one is open to decide. */
  approvalOpen: boolean;
  /** Obsolete revision the person tried to decide, named in a notice. */
  obsoleteNotice: number | null;
  /** Decision this person just recorded, shown until the next read. */
  decided: PlanDecision | null;
  /** Name of a teammate who decided, or null when the reader decided. */
  decidedBy?: string | null;
  phase: PlanPhase;
  offline: boolean;
  /**
   * An agent turn is queued or running and may still open the approval, so
   * the "no approval is open" notice stays quiet. Decisions are never paused:
   * the server decides by approval id and version.
   */
  paused?: boolean;
  onDecide: (decision: PlanDecision, comment: string | undefined) => void;
  onRetry: () => void;
  /** Refreshes the conversation; offered when this revision is obsolete. */
  onRefresh?: () => void;
}>;

export type PlanRevisionParts = Readonly<{
  /** Pane section with the revision, its steps and any notices. */
  body: ReactNode;
  /** Decision actions pinned to the pane footer, or null. */
  footer: ReactNode;
}>;

/**
 * Plan revision with numbered steps and the three decisions, each bound to
 * the approval id and version the container sends. An obsolete revision shows
 * no decision controls and a clear conflict state. The body belongs in the
 * inspector and the actions in its footer, so both come back separately.
 */
export function usePlanRevision(
  {
    revision,
    status,
    body,
    approvalOpen,
    obsoleteNotice,
    decided,
    decidedBy = null,
    phase,
    offline,
    paused = false,
    onDecide,
    onRetry,
    onRefresh,
  }: PlanRevisionPanelProps,
): PlanRevisionParts {
  const { translate: t } = useI18n();
  const id = useId();
  // The change-request draft belongs to one revision: a newer revision starts
  // with no comment and the decision buttons, never the old text.
  const [draft, setDraft] = useState({ revision, asking: false, comment: "" });
  const current = draft.revision === revision
    ? draft
    : { revision, asking: false, comment: "" };
  // A recorded decision closes the change-request form: it never reopens
  // when the next open approval makes this panel decidable again.
  if (decided !== null && current.asking) {
    setDraft({ revision, asking: false, comment: "" });
  }
  const { asking, comment } = current;
  const setAsking = (next: boolean) => setDraft({ ...current, asking: next });
  const setComment = (next: string) => setDraft({ ...current, comment: next });
  const locked = phase === "deciding" || phase === "unknown";
  const obsolete = status === "superseded";
  const decidable = approvalOpen && status === "proposed" && decided === null;
  const notice = phase === "conflict"
    ? { tone: "error" as const, text: t("tasks.conversation.plan.conflict") }
    : phase === "forbidden"
    ? { tone: "error" as const, text: t("tasks.conversation.plan.forbidden") }
    : phase === "error"
    ? { tone: "error" as const, text: t("tasks.conversation.plan.failed") }
    : phase === "unknown"
    ? { tone: "warning" as const, text: t("tasks.conversation.plan.unknown") }
    : phase === "deciding"
    ? {
      tone: "information" as const,
      text: t("tasks.conversation.plan.deciding"),
    }
    : null;
  const shown = obsolete ? "superseded" : status;
  if (revision === null) return { body: null, footer: null };
  const partsBody = (
    <UI.PaneSection
      data-ui-region="plan-revision"
      data-revision={revision}
      data-status={shown}
      aria-label={t("tasks.conversation.plan.heading")}
      role="region"
    >
      {(obsoleteNotice !== null || obsolete) && (
        <UI.InlineNotice layout="bar" icon="caution" tone="warning">
          {t("tasks.conversation.plan.obsolete", {
            revision: String(obsoleteNotice ?? revision),
          })}
        </UI.InlineNotice>
      )}
      <UI.PlanRevisionSummary
        title={body.title}
        revision={t("tasks.conversation.plan.revision", {
          revision: String(revision),
        })}
        status={{
          label: t(`tasks.conversation.plan.status.${shown}`),
          tone: shown === "proposed"
            ? "warning"
            : shown === "approved"
            ? "success"
            : shown === "rejected"
            ? "destructive"
            : "neutral",
        }}
        stepsLabel={t("tasks.conversation.plan.steps")}
        steps={body.steps}
        state={obsolete ? "muted" : "current"}
      />
      {decided !== null && (
        <UI.InlineNotice tone="success">
          {t(
            decidedBy === null
              ? `tasks.conversation.plan.decided.${decided}`
              : `tasks.conversation.plan.decidedBy.${decided}`,
            { revision: String(revision), name: decidedBy ?? "" },
          )}
        </UI.InlineNotice>
      )}
      {!approvalOpen && status === "proposed" && decided === null &&
        !paused && (
        <UI.InlineNotice tone="neutral">
          {t("tasks.conversation.plan.noApproval")}
        </UI.InlineNotice>
      )}
      {obsolete && onRefresh && (
        <UI.Stack gap="compact">
          <UI.Button disabled>
            {t("tasks.conversation.plan.approve", {
              revision: String(revision),
            })}
          </UI.Button>
          <UI.Button variant="outline" onClick={onRefresh}>
            {t("tasks.conversation.refresh")}
          </UI.Button>
        </UI.Stack>
      )}
      <div aria-atomic="true" aria-live="polite" role="status">
        {notice && (
          <UI.InlineNotice role="none" tone={notice.tone}>
            {notice.text}
          </UI.InlineNotice>
        )}
      </div>
      {decidable && asking && (
        <UI.Field
          htmlFor={`${id}-comment`}
          label={t("tasks.conversation.plan.comment")}
          hint={t("tasks.conversation.plan.commentHint")}
          variant="textarea"
        >
          <textarea
            id={`${id}-comment`}
            name="comment"
            rows={3}
            value={comment}
            readOnly={locked}
            onChange={(event) => setComment(event.currentTarget.value)}
          />
        </UI.Field>
      )}
    </UI.PaneSection>
  );
  // An unknown outcome whose approval is no longer open to this person has
  // nothing to retry; refreshing reads the recorded outcome.
  const footer = !decidable && phase === "unknown" && onRefresh
    ? (
      <UI.Button variant="outline" onClick={onRefresh}>
        {t("tasks.conversation.refresh")}
      </UI.Button>
    )
    : decidable
    ? phase === "unknown"
      ? (
        <UI.Button onClick={onRetry} disabled={offline}>
          {t("tasks.conversation.plan.retry")}
        </UI.Button>
      )
      : asking
      ? (
        <>
          <UI.Button
            disabled={locked || offline || comment.trim() === ""}
            loading={phase === "deciding"}
            onClick={() => onDecide("request_changes", comment.trim())}
          >
            {t("tasks.conversation.plan.sendChanges")}
          </UI.Button>
          <UI.Button
            variant="outline"
            disabled={locked}
            onClick={() => setAsking(false)}
          >
            {t("tasks.conversation.plan.cancelChanges")}
          </UI.Button>
        </>
      )
      : (
        <>
          <UI.Button
            disabled={locked || offline}
            onClick={() => onDecide("approve", undefined)}
          >
            {t("tasks.conversation.plan.approve", {
              revision: String(revision),
            })}
          </UI.Button>
          <UI.Button
            variant="outline"
            disabled={locked || offline}
            onClick={() => setAsking(true)}
          >
            {t("tasks.conversation.plan.requestChanges")}
          </UI.Button>
          <UI.Button
            variant="destructive-outline"
            disabled={locked || offline}
            onClick={() => onDecide("reject", undefined)}
          >
            {t("tasks.conversation.plan.reject")}
          </UI.Button>
        </>
      )
    : null;
  return { body: partsBody, footer };
}
