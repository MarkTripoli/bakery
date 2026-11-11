import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type ArtifactCommentProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    actions?: ReactNode;
    author: ReactNode;
    children: ReactNode;
    location?: ReactNode;
    resolved?: boolean;
    state?: "open" | "resolved" | "outdated";
    stateLabel?: ReactNode;
    timestamp?: string;
    variant?: "thread" | "reply";
  };

/** A discussion comment attached to a named artifact or location. */
export function ArtifactComment(
  {
    actions,
    author,
    children,
    location,
    resolved = false,
    state,
    stateLabel,
    timestamp,
    variant = "thread",
    ...props
  }: ArtifactCommentProps,
) {
  const resolvedState = state ?? (resolved ? "resolved" : "open");
  return (
    <article
      className={[
        "ui-artifact-comment",
        resolvedState === "resolved" && "ui-artifact-comment--resolved",
      ]
        .filter(Boolean).join(" ")}
      aria-atomic={resolvedState === "outdated" ? "true" : undefined}
      aria-live={resolvedState === "outdated" ? "polite" : undefined}
      {...props}
      data-state={resolvedState}
      data-ui-component="artifactComment"
      data-variant={variant}
    >
      <header>
        <strong>{author}</strong>
        {location ? <span>{location}</span> : null}
        {timestamp ? <time dateTime={timestamp}>{timestamp}</time> : null}
        <span>
          {stateLabel ??
            (resolvedState === "resolved" ? "Resolved" : resolvedState)}
        </span>
      </header>
      <div className="ui-artifact-comment__body">{children}</div>
      {actions ? <footer>{actions}</footer> : null}
    </article>
  );
}
