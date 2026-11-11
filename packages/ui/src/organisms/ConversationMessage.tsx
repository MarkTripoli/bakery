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
    timestamp?: string;
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
        {timestamp ? <time dateTime={timestamp}>{timestamp}</time> : null}
      </header>
      <div className="ui-conversation-message__body">{children}</div>
      {actions ? <footer>{actions}</footer> : null}
    </article>
  );
}
