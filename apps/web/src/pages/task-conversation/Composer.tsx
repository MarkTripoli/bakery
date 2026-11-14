import { useId } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
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
  /** Prompt to discuss results after a finished run. */
  resultsHint: boolean;
  onBody: (value: string) => void;
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
    resultsHint,
    onBody,
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
    phase !== "forbidden";
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
          {runActive && (
            <UI.InlineNotice layout="bar" tone="information">
              {t("tasks.conversation.steering.saved")}
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
      field={
        <textarea
          id={MESSAGE_FIELD_ID}
          name="message"
          aria-label={t("tasks.conversation.composer.label")}
          rows={1}
          placeholder={t("tasks.conversation.composer.placeholder")}
          value={body}
          readOnly={locked}
          aria-invalid={tooLong || undefined}
          aria-describedby={tooLong ? `${id}-error` : `${id}-draft`}
          onChange={(event) => onBody(event.currentTarget.value)}
          onKeyDown={(event) => {
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
            disabled={!canSend}
            loading={phase === "sending"}
          >
            <UI.IconGlyph name="arrow" size="small" />
            {phase === "sending"
              ? t("tasks.conversation.composer.sending")
              : t("tasks.conversation.composer.send")}
          </UI.Button>
        )}
      footnote={
        <>
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
