import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type QuestionCardProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    actions?: ReactNode;
    answer?: ReactNode;
    answerLabel?: string;
    children: ReactNode;
    description?: ReactNode;
    /** Quiet label above the title, such as "Question from the agent". */
    eyebrow?: ReactNode;
    /** `inline` drops the card frame for an inspector or pane body; `pane`
     * is the p-18-0 conversation inspector question. */
    layout?: "card" | "inline" | "pane";
    /** Translated status text shown as the pill in the `pane` layout. */
    statusLabel?: string;
    status?: "open" | "answered" | "expired" | "conflict";
    title: ReactNode;
    variant?: "singleChoice" | "multipleChoice" | "text";
  };

/** A question and its optional recorded answer. */
export function QuestionCard(
  {
    actions,
    answer,
    answerLabel = "Answer",
    children,
    description,
    eyebrow,
    layout = "card",
    statusLabel,
    status = "open",
    title,
    variant = "singleChoice",
    ...props
  }: QuestionCardProps,
) {
  return (
    <article
      className={[
        "ui-question-card",
        `ui-question-card--${status}`,
        `ui-question-card--${layout}`,
      ].join(" ")}
      aria-atomic={status === "conflict" ? "true" : undefined}
      aria-live={status === "conflict" ? "polite" : undefined}
      {...props}
      data-state={status}
      data-ui-component="questionCard"
      data-variant={variant}
    >
      <header>
        {eyebrow
          ? <span className="ui-question-card__eyebrow">{eyebrow}</span>
          : null}
        <h3>{title}</h3>
        <span className="ui-question-card__status">
          {statusLabel ?? status}
        </span>
        {description && layout !== "pane"
          ? <p className="ui-question-card__description">{description}</p>
          : null}
      </header>
      <div className="ui-question-card__body">{children}</div>
      {description && layout === "pane"
        ? <p className="ui-question-card__description">{description}</p>
        : null}
      {actions
        ? <div className="ui-question-card__actions">{actions}</div>
        : null}
      {answer
        ? (
          <section
            aria-label={answerLabel}
            className="ui-question-card__answer"
          >
            <strong>{answerLabel}</strong>
            <div>{answer}</div>
          </section>
        )
        : null}
    </article>
  );
}
