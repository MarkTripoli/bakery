import { useEffect, useId, useState } from "react";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { useApprovalDecision } from "../task-delivery/use-approval-decision.ts";
import { ArtifactPreviewBody } from "../ArtifactContentPreview.tsx";
import { capitalized, minutesLeft, refusalOf, stepName } from "./model.ts";
import { useStepApproval } from "./use-step-approval.ts";

type Choice = "approve" | "request_changes" | "reject";

export function StepApprovalPane(
  { taskId, runId, layout, online, onClose }: {
    taskId: string;
    runId: string;
    layout: "rail" | "sheet";
    online: boolean;
    onClose: () => void;
  },
) {
  const { translate: t, locale, timeZone } = useI18n();
  const id = useId();
  const read = useStepApproval(taskId, runId, { withDocument: true });
  const [kept, setKept] = useState(read.approval);
  const [done, setDone] = useState<Choice | null>(null);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => {
    if (read.approval !== null) setKept(read.approval);
  }, [read.approval]);
  const approval = read.approval ?? kept;
  const { phase, decide, refusal } = useApprovalDecision(
    read.approval,
    read.refresh,
  );
  const step = stepName(read.step?.stepKey ?? null);
  const locked = phase === "deciding" || phase === "unknown";
  const open = read.approval !== null && done === null;
  const send = async (choice: Choice) => {
    const result = await decide(
      choice,
      choice === "request_changes" ? comment.trim() : "",
    );
    if (result === "idle") setDone(choice);
  };
  const notice = phase === "deciding"
    ? { tone: "information" as const, text: t("tasks.stepApproval.deciding") }
    : phase === "unknown"
    ? {
      tone: "warning" as const,
      text: t("tasks.stepApproval.refusal.unknown"),
    }
    : phase === "forbidden"
    ? {
      tone: "error" as const,
      text: t("tasks.stepApproval.refusal.forbidden"),
    }
    : phase === "conflict" || phase === "error"
    ? {
      tone: "error" as const,
      text: t(
        `tasks.stepApproval.refusal.${
          refusalOf(refusal ?? { status: null, reason: null })
        }`,
      ),
    }
    : done !== null
    ? {
      tone: "success" as const,
      text: t("tasks.stepApproval.decided", { step }),
    }
    : null;
  const left = minutesLeft(approval?.expiresAt ?? null, Date.now());
  const asked = approval
    ? t("tasks.stepApproval.asked", {
      time: formatDate(new Date(approval.createdAt), locale, {
        timeZone,
        timeStyle: "short",
      }),
      left: left === null
        ? ""
        : t(`tasks.stepApproval.left.${left.unit}`, { count: left.count }),
    })
    : null;
  const body = (
    <UI.PaneSection
      data-ui-region="step-approval"
      data-approval-id={approval?.id}
      aria-label={capitalized(step)}
      role="region"
    >
      <UI.Stack gap="standard">
        {asked && left !== null && <UI.Text variant="hint">{asked}</UI.Text>}
        {read.document
          ? (
            <ArtifactPreviewBody
              version={read.document}
              label={t("tasks.stepApproval.documentLabel", { step })}
              cutText
            />
          )
          : read.documentPending
          ? (
            <UI.Text variant="hint">
              {t("tasks.stepApproval.documentLoading")}
            </UI.Text>
          )
          : approval
          ? <UI.Text>{approval.prompt}</UI.Text>
          : null}
        <div aria-atomic="true" aria-live="polite" role="status">
          {notice && (
            <UI.InlineNotice role="none" tone={notice.tone}>
              {notice.text}
            </UI.InlineNotice>
          )}
        </div>
        {open && asking && (
          <UI.Field
            htmlFor={`${id}-comment`}
            label={t("tasks.stepApproval.comment")}
            hint={t("tasks.stepApproval.commentHint", { step })}
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
      </UI.Stack>
    </UI.PaneSection>
  );
  const footer = !open
    ? (
      <UI.Button variant="outline" onClick={onClose}>
        {t("tasks.stepApproval.close")}
      </UI.Button>
    )
    : phase === "unknown"
    ? (
      <UI.Button
        disabled={!online}
        onClick={() => void send(asking ? "request_changes" : "approve")}
      >
        {t("tasks.stepApproval.retry")}
      </UI.Button>
    )
    : asking
    ? (
      <>
        <UI.Button
          variant="outline"
          disabled={locked}
          onClick={() => setAsking(false)}
        >
          {t("tasks.stepApproval.keepReviewing")}
        </UI.Button>
        <UI.Button
          disabled={locked || !online || comment.trim() === ""}
          loading={phase === "deciding"}
          onClick={() => void send("request_changes")}
        >
          {t("tasks.stepApproval.sendChanges")}
        </UI.Button>
      </>
    )
    : (
      <>
        <UI.Button
          variant="destructive-outline"
          disabled={locked || !online}
          onClick={() => setRejecting(true)}
        >
          {t("tasks.stepApproval.reject")}
        </UI.Button>
        <UI.Button
          variant="outline"
          disabled={locked || !online}
          onClick={() => setAsking(true)}
        >
          {t("tasks.stepApproval.requestChanges")}
        </UI.Button>
        <UI.Button
          disabled={locked || !online}
          loading={phase === "deciding"}
          onClick={() => void send("approve")}
        >
          {t("tasks.stepApproval.approve")}
        </UI.Button>
      </>
    );
  const dialog = (
    <UI.AlertDialog
      cancelAction={
        <UI.Button
          variant="outline"
          onClick={() => setRejecting(false)}
        >
          {t("tasks.stepApproval.rejectCancel")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          variant="destructive"
          onClick={() => {
            setRejecting(false);
            void send("reject");
          }}
        >
          {t("tasks.stepApproval.rejectConfirm")}
        </UI.Button>
      }
      onOpenChange={(next) => !next && setRejecting(false)}
      open={rejecting}
      title={t("tasks.stepApproval.rejectTitle", { step })}
    >
      {t("tasks.stepApproval.rejectBody")}
    </UI.AlertDialog>
  );
  if (layout === "sheet") {
    return (
      <>
        <UI.Sheet
          open
          onOpenChange={(next) => !next && onClose()}
          title={capitalized(step)}
          dismissLabel={t("tasks.stepApproval.close")}
          data-ui-region="step-approval-sheet"
        >
          {body}
          <UI.Inline variant="actions">{footer}</UI.Inline>
        </UI.Sheet>
        {dialog}
      </>
    );
  }
  return (
    <>
      <UI.SessionPane
        label={capitalized(step)}
        layout="sections"
        header={
          <>
            <UI.Text>{capitalized(step)}</UI.Text>
            <UI.Text variant="hint">{t("tasks.stepApproval.caption")}</UI.Text>
          </>
        }
        footer={footer}
      >
        {body}
      </UI.SessionPane>
      {dialog}
    </>
  );
}
