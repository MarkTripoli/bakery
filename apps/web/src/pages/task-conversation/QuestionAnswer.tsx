import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { QuestionOption } from "./model.ts";

export type QuestionPhase =
  | "idle"
  | "sending"
  | "unknown"
  | "forbidden"
  | "conflict"
  | "error";

export type QuestionAnswerProps = Readonly<{
  id: string;
  prompt: string;
  status: "open" | "answered" | "withdrawn" | "expired" | "superseded";
  options: readonly QuestionOption[];
  allowFreeText: boolean;
  /** Recorded answer text for an answered question. */
  answered: string;
  /** Name of the teammate who answered, or null when unknown or the reader. */
  answeredBy?: string | null;
  phase: QuestionPhase;
  offline: boolean;
  /** Option chosen before the reader picks one; a design fixture sets it. */
  defaultOptionId?: string;
  /** `inline` is the work queue inspector body; `pane` the conversation. */
  layout?: "inline" | "pane";
  onAnswer: (answer: { optionId?: string; text?: string }) => void;
  onRetry: () => void;
}>;

/** A durable question: open ones are answerable, others show the record. */
export function QuestionAnswer(
  {
    id,
    prompt,
    status,
    options,
    allowFreeText,
    answered,
    answeredBy = null,
    phase,
    offline,
    defaultOptionId,
    layout = "pane",
    onAnswer,
    onRetry,
  }: QuestionAnswerProps,
) {
  const { translate: t } = useI18n();
  const group = useId();
  const [optionId, setOptionId] = useState<string | undefined>(
    defaultOptionId,
  );
  const [text, setText] = useState("");
  const open = status === "open";
  const showText = allowFreeText || options.length === 0;
  const locked = phase === "sending" || phase === "unknown";
  const ready = optionId !== undefined || text.trim() !== "";
  const serverStatus = status === "answered"
    ? "answered"
    : status === "open"
    ? "open"
    : "expired";
  // The conflict phase is a notice; it never replaces the server status label.
  const cardStatus = phase === "conflict" ? "conflict" : serverStatus;
  const notice = phase === "conflict"
    ? t("tasks.conversation.question.conflict")
    : phase === "forbidden"
    ? t("tasks.conversation.question.forbidden")
    : phase === "error"
    ? t("tasks.conversation.question.failed")
    : phase === "unknown"
    ? t("tasks.conversation.question.unknown")
    : status === "expired" || status === "withdrawn" || status === "superseded"
    ? t("tasks.conversation.question.expired")
    : null;
  return (
    <UI.QuestionCard
      data-question-id={id}
      layout={layout}
      eyebrow={layout === "pane"
        ? t("tasks.conversation.question.heading")
        : undefined}
      statusLabel={t(`tasks.conversation.question.status.${serverStatus}`)}
      title={prompt}
      description={open
        ? t("tasks.conversation.question.resume")
        : answeredBy !== null && status === "answered"
        ? t("tasks.conversation.question.answeredBy", { name: answeredBy })
        : undefined}
      status={cardStatus}
      variant={options.length === 0 ? "text" : "singleChoice"}
      answerLabel={t("tasks.conversation.question.answeredLabel")}
      answer={answered || undefined}
      actions={open
        ? (
          phase === "unknown"
            ? (
              <UI.Button onClick={onRetry} disabled={offline}>
                {t("tasks.conversation.question.retry")}
              </UI.Button>
            )
            : (
              <UI.Button
                disabled={!ready || locked || offline}
                loading={phase === "sending"}
                onClick={() =>
                  onAnswer({
                    ...(optionId === undefined ? {} : { optionId }),
                    ...(text.trim() === "" ? {} : { text: text.trim() }),
                  })}
              >
                {phase === "sending"
                  ? t("tasks.conversation.question.sending")
                  : t("tasks.conversation.question.answer")}
              </UI.Button>
            )
        )
        : undefined}
    >
      {open && options.map((option) => (
        <UI.Radio
          key={option.id}
          name={group}
          value={option.id}
          checked={optionId === option.id}
          disabled={locked}
          onChange={() => setOptionId(option.id)}
        >
          {option.label}
        </UI.Radio>
      ))}
      {open && showText && (
        <UI.Field
          htmlFor={`${group}-text`}
          label={t("tasks.conversation.question.freeText")}
          variant="textarea"
        >
          <textarea
            id={`${group}-text`}
            name="answer"
            rows={2}
            value={text}
            readOnly={locked}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </UI.Field>
      )}
      {
        /* The inline body spaces every child, so its empty live region is
          only mounted with a notice. */
      }
      {(layout === "pane" || notice) && (
        <div aria-atomic="true" aria-live="polite" role="status">
          {notice && (
            <UI.InlineNotice
              role="none"
              tone={phase === "unknown" ? "warning" : "error"}
            >
              {notice}
            </UI.InlineNotice>
          )}
        </div>
      )}
    </UI.QuestionCard>
  );
}
