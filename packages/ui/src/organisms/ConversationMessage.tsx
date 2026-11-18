import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type ConversationMessageProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    actions?: ReactNode;
    author: ReactNode;
    children: ReactNode;
    state?: "sending" | "sent" | "failed" | "edited";
    /** Short label the reader sees, usually a relative time. */
    timestamp?: string;
    /**
     * Exact timestamp behind `timestamp`, used for `datetime` and the title, so
     * a shortened label never hides when the message actually happened.
     */
    timestampTitle?: string;
    variant?: "person" | "agent" | "system";
  };

/** A single authored message in a conversation transcript. */
export function ConversationMessage(
  {
    actions,
    author,
    children,
    state = "sent",
    timestamp,
    timestampTitle,
    variant = "person",
    ...props
  }: ConversationMessageProps,
) {
  return (
    <article
      className={[
        "ui-conversation-message",
        `ui-conversation-message--${variant}`,
      ].filter(Boolean).join(" ")}
      aria-atomic={state === "failed" ? "true" : undefined}
      aria-live={state === "failed" ? "polite" : undefined}
      {...props}
      data-state={state}
      data-variant={variant}
      data-ui-component="conversationMessage"
    >
      <header>
        <strong>{author}</strong>
        {timestamp
          ? (
            <time dateTime={timestampTitle ?? timestamp} title={timestampTitle}>
              {timestamp}
            </time>
          )
          : null}
      </header>
      <div className="ui-conversation-message__body">{children}</div>
      {actions ? <footer>{actions}</footer> : null}
    </article>
  );
}
