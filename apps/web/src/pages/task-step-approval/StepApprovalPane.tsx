import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ReferenceLink } from "../../app/ReferenceLink.tsx";
import { useApprovalDecision } from "../task-delivery/use-approval-decision.ts";
import {
  capitalized,
  type Decision,
  decisionOf,
  refusalOf,
  stepName,
} from "./model.ts";
import { useStepApproval } from "./use-step-approval.ts";

type Asking = "request_changes" | "reject" | null;

export function StepApprovalPane(
  { taskId, runId, layout, online, onClose, onDecided }: {
    taskId: string;
    runId: string;
    layout: "rail" | "sheet";
    online: boolean;
    onClose: () => void;
    onDecided: (decision: Decision) => void;
  },
) {
  const { translate: t, locale, timeZone } = useI18n();
  const id = useId();
  const read = useStepApproval(taskId, runId);
  const { phase, decide, refusal } = useApprovalDecision(
    read.approval,
    read.refresh,
  );
  const [asking, setAsking] = useState<Asking>(null);
  const [note, setNote] = useState("");
  const [empty, setEmpty] = useState(false);
  const approval = read.approval ?? read.latest;
  const title = capitalized(stepName(read.step?.stepKey ?? null));
  const step = stepName(read.step?.stepKey ?? null);
  const locked = phase === "deciding" || phase === "unknown";
  const open = read.approval !== null;
  const timeOf = (iso: string) =>
    formatDate(new Date(iso), locale, { timeZone, timeStyle: "short" });
  const dateOf = (iso: string) =>
    formatDate(new Date(iso), locale, { timeZone, dateStyle: "medium" });
  const send = async (choice: Decision, comment: string) => {
    const result = await decide(choice, comment);
    if (result === "idle") onDecided(choice);
  };
  const confirmAsk = async () => {
    if (asking === null) return;
    const text = note.trim();
    if (asking === "request_changes" && text === "") {
      setEmpty(true);
      return;
    }
    const choice = asking;
    setAsking(null);
    setNote("");
    setEmpty(false);
    await send(choice, text);
  };
  const cancelAsk = () => {
    setAsking(null);
    setNote("");
    setEmpty(false);
  };
  const earlier = read.latest !== null && read.approval === null
    ? decisionOf(read.latest)
    : null;
  const refusalText = () => {
    const kind = refusalOf(refusal ?? { status: null, reason: null });
    if (kind !== "decided") return t(`tasks.stepApproval.refusal.${kind}`);
    const decision = decisionOf(read.latest);
    if (decision === null) return t("tasks.stepApproval.refusal.failed");
    const name = read.nameOf(read.latest?.decidedBy ?? null);
    if (name === null || read.latest?.decidedAt == null) {
      return t("tasks.stepApproval.refusal.decidedWord", {
        decision: t(`tasks.stepApproval.word.${decision}`),
      });
    }
    const key = decision === "approve"
      ? "alreadyApprove"
      : decision === "reject"
      ? "alreadyReject"
      : "alreadyRequestChanges";
    return (
      <>
        <ReferenceLink kind="person" value={name} />{" "}
        {t(`tasks.stepApproval.refusal.${key}`, {
          time: timeOf(read.latest.decidedAt),
        })}
      </>
    );
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
    ? { tone: "error" as const, text: refusalText() }
    : earlier !== null
    ? { tone: "information" as const, text: refusalText() }
    : null;
  const body = (
    <UI.PaneSection
      data-ui-region="step-approval"
      data-approval-id={approval?.id}
      aria-label={title}
      role="region"
    >
      <UI.Stack gap="standard">
        {approval && (
          <UI.Text variant="hint">
            {t("tasks.stepApproval.asked", {
              time: timeOf(approval.createdAt),
              date: approval.expiresAt === null
                ? ""
                : dateOf(approval.expiresAt),
            })}
          </UI.Text>
        )}
        {approval && <UI.Text>{approval.prompt}</UI.Text>}
        <UI.Link
          href="#task-run-artifacts"
          variant="sentence"
          onClick={(event) => {
            event.preventDefault();
            const target = document.getElementById("task-run-artifacts");
            target?.scrollIntoView({ block: "start" });
            target?.focus();
          }}
        >
          {t("tasks.stepApproval.seeWrote")}
        </UI.Link>
        <div aria-atomic="true" aria-live="polite" role="status">
          {notice && (
            <UI.InlineNotice role="none" tone={notice.tone}>
              {notice.text}
            </UI.InlineNotice>
          )}
        </div>
      </UI.Stack>
    </UI.PaneSection>
  );
  const footer = !open ? null : phase === "unknown"
    ? (
      <UI.Button
        disabled={!online}
        onClick={() => void send("approve", "")}
      >
        {t("tasks.stepApproval.retry")}
      </UI.Button>
    )
    : (
      <>
        <UI.Button
          variant="primary"
          disabled={locked || !online}
          loading={phase === "deciding"}
          onClick={() => void send("approve", "")}
        >
          {t("tasks.stepApproval.approve")}
        </UI.Button>
        <UI.Button
          variant="outline"
          disabled={locked || !online}
          onClick={() => setAsking("request_changes")}
        >
          {t("tasks.stepApproval.requestChanges")}
        </UI.Button>
        <UI.Button
          variant="destructive-outline"
          disabled={locked || !online}
          onClick={() => setAsking("reject")}
        >
          {t("tasks.stepApproval.reject")}
        </UI.Button>
      </>
    );
  const asksChanges = asking === "request_changes";
  const dialog = (
    <UI.AlertDialog
      cancelAction={
        <UI.Button variant="outline" onClick={cancelAsk}>
          {t("tasks.stepApproval.cancel")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          variant={asksChanges ? "primary" : "destructive"}
          onClick={() => void confirmAsk()}
        >
          {asksChanges
            ? t("tasks.stepApproval.changesConfirm")
            : t("tasks.stepApproval.rejectConfirm")}
        </UI.Button>
      }
      onOpenChange={(next) => !next && cancelAsk()}
      open={asking !== null}
      title={asksChanges
        ? t("tasks.stepApproval.changesTitle", { step })
        : t("tasks.stepApproval.rejectTitle", { step })}
    >
      <UI.Stack gap="standard">
        <UI.Text>
          {asksChanges
            ? t("tasks.stepApproval.changesBody")
            : t("tasks.stepApproval.rejectBody")}
        </UI.Text>
        <UI.Field
          htmlFor={`${id}-note`}
          label={asksChanges
            ? t("tasks.stepApproval.changesField")
            : t("tasks.stepApproval.rejectField")}
          error={asksChanges && empty
            ? t("tasks.stepApproval.changesRequired")
            : undefined}
          variant="textarea"
        >
          <textarea
            id={`${id}-note`}
            name="note"
            rows={3}
            value={note}
            onChange={(event) => {
              setNote(event.currentTarget.value);
              setEmpty(false);
            }}
          />
        </UI.Field>
      </UI.Stack>
    </UI.AlertDialog>
  );
  const closeButton = (
    <UI.IconButton
      label={t("tasks.stepApproval.close")}
      variant="compact"
      onClick={onClose}
    >
      <UI.IconGlyph name="close" />
    </UI.IconButton>
  );
  if (layout === "sheet") {
    return (
      <>
        <UI.Sheet
          open
          onOpenChange={(next) => !next && onClose()}
          title={title}
          dismissLabel={t("tasks.stepApproval.close")}
          data-ui-region="step-approval-sheet"
        >
          {body}
          {footer && <UI.Inline variant="actions">{footer}</UI.Inline>}
        </UI.Sheet>
        {dialog}
      </>
    );
  }
  return (
    <>
      <UI.SessionPane
        label={title}
        layout="sections"
        header={
          <>
            <UI.Text>{title}</UI.Text>
            {closeButton}
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
