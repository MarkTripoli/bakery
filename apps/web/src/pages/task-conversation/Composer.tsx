import { useId } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { MentionField } from "../../mentions/useMentionField.tsx";
import type { DraftIntent } from "./draft.ts";

export const MESSAGE_MAX = 20_000;
/** The message field's id, so the delivery section can focus it. */
export const MESSAGE_FIELD_ID = "task-message-field";

export type ComposerProps = Readonly<{
  body: string;
  intent: DraftIntent;
  phase: "idle" | "sending" | "unknown" | "forbidden" | "error";
  offline: boolean;
  /** A run is in progress: messages are saved and routed by run capabilities. */
  runActive: boolean;
  /** The run waits for another task: the notice says so instead. */
  runBlocked?: boolean;
  /** Prompt to discuss results after a finished run. */
  resultsHint: boolean;
  /** The mention field: the textarea's props, the picker, the chips and what the server refused. */
  mentionField: MentionField;
  onIntent: (value: DraftIntent) => void;
  onSend: () => void;
  onRetry: () => void;
}>;

/**
 * Message composer. The draft is private to this browser and only leaves it
 * when Send is pressed; the intent chooses between team discussion and an
 * agent turn.
 */
export function Composer(
  {
    body,
    intent,
    phase,
    offline,
    runActive,
    runBlocked = false,
    resultsHint,
    mentionField,
    onIntent,
    onSend,
    onRetry,
  }: ComposerProps,
) {
  const { translate: t } = useI18n();
  const id = useId();
  const tooLong = body.length > MESSAGE_MAX;
  const locked = phase === "sending" || phase === "unknown";
  const canSend = !locked && !offline && body.trim() !== "" && !tooLong &&
    phase !== "forbidden" && !mentionField.refused && !mentionField.blocked;
  // A send that was giving access failed on the server: nothing was given.
  const failedOffer = phase === "error" ? mentionField.failed : null;
  const reasonId = `${id}-reason`;
  const notice = phase === "unknown"
    ? {
      tone: "warning" as const,
      text: t("tasks.conversation.composer.unknown"),
    }
    : phase === "forbidden"
    ? {
      tone: "error" as const,
      text: t("tasks.conversation.composer.forbidden"),
    }
    : failedOffer !== null
    ? {
      tone: "error" as const,
      text: `${failedOffer.line} ${failedOffer.detail}`,
    }
    : phase === "error"
    ? { tone: "error" as const, text: t("tasks.conversation.composer.failed") }
    : null;
  return (
    <UI.MessageComposer
      data-ui-region="composer"
      aria-label={t("tasks.conversation.composer.label")}
      state={phase === "sending" ? "sending" : "default"}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
      notices={
        <>
          {mentionField.notice !== null && (
            <UI.InlineNotice layout="bar" role="alert" tone="error">
              {mentionField.notice}
            </UI.InlineNotice>
          )}
          {runActive && (
            <UI.InlineNotice layout="bar" tone="information">
              {t("tasks.conversation.steering.saved")}
            </UI.InlineNotice>
          )}
          {runBlocked && (
            <UI.InlineNotice layout="bar" tone="warning">
              {t("tasks.conversation.steering.blocked")}
            </UI.InlineNotice>
          )}
          {resultsHint && (
            <UI.InlineNotice layout="bar" tone="neutral">
              {t("tasks.conversation.results.hint")}
            </UI.InlineNotice>
          )}
          <div aria-atomic="true" aria-live="polite" role="status">
            {notice && (
              <UI.InlineNotice layout="bar" role="none" tone={notice.tone}>
                {notice.text}
              </UI.InlineNotice>
            )}
          </div>
        </>
      }
      picker={mentionField.picker}
      mentions={mentionField.row}
      field={
        <textarea
          {...mentionField.fieldProps}
          id={MESSAGE_FIELD_ID}
          name="message"
          aria-label={t("tasks.conversation.composer.label")}
          rows={1}
          placeholder={t("tasks.conversation.composer.placeholder")}
          readOnly={locked}
          aria-invalid={tooLong || undefined}
          aria-describedby={tooLong ? `${id}-error` : `${id}-draft`}
          onKeyDown={(event) => {
            mentionField.fieldProps.onKeyDown(event);
            if (event.defaultPrevented) return;
            if (
              event.key === "Enter" && (event.metaKey || event.ctrlKey) &&
              canSend
            ) {
              event.preventDefault();
              onSend();
            }
          }}
        />
      }
      modes={
        <UI.SegmentedControl
          aria-label={t("tasks.conversation.intent.label")}
          name={`${id}-intent`}
          variant="inline"
          value={intent}
          onChange={(value) => onIntent(value === "ask" ? "ask" : "discuss")}
          options={[
            { value: "discuss", label: t("tasks.conversation.intent.discuss") },
            { value: "ask", label: t("tasks.conversation.intent.ask") },
          ]}
        />
      }
      hint={intent === "ask"
        ? t("tasks.conversation.intent.askHint")
        : t("tasks.conversation.intent.discussHint")}
      send={phase === "unknown"
        ? (
          <UI.Button onClick={onRetry} disabled={offline}>
            {t("tasks.conversation.composer.retry")}
          </UI.Button>
        )
        : (
          <UI.Button
            type="submit"
            aria-describedby={mentionField.sendReason !== null
              ? reasonId
              : undefined}
            disabled={!canSend}
            loading={phase === "sending"}
          >
            <UI.IconGlyph name="arrow" size="small" />
            {phase === "sending"
              ? mentionField.sendLabel !== null
                ? t("mentions.offer.sending")
                : t("tasks.conversation.composer.sending")
              : failedOffer !== null
              ? t("mentions.failed.retry")
              : mentionField.sendLabel ?? t("tasks.conversation.composer.send")}
          </UI.Button>
        )}
      footnote={
        <>
          {mentionField.sendReason !== null
            ? (
              <>
                <span id={reasonId} role="status">
                  {mentionField.sendReason}
                </span>
                <br />
              </>
            )
            : null}
          {tooLong
            ? (
              <span id={`${id}-error`} role="alert">
                {t("tasks.conversation.composer.tooLong", {
                  max: String(MESSAGE_MAX),
                })}
              </span>
            )
            : null}
          <span id={`${id}-draft`} hidden>
            {t("tasks.conversation.composer.draft")}
          </span>
          {t("tasks.conversation.composer.shared")}
        </>
      }
    />
  );
}
