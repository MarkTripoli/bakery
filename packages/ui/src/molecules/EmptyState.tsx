import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type EmptyStateProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    action?: ReactNode;
    description?: ReactNode;
    /** Glyph above the title; used by the centered layout. */
    icon?: ReactNode;
    /** `page` insets a block layout by the 32px page inset (p-18-0). */
    inset?: "none" | "page";
    /** `centered` fills its container with a quiet centered message. */
    layout?: "block" | "centered";
    title: ReactNode;
    variant?: "firstUse" | "filtered" | "complete";
  };

/** Explains why a bounded collection has no content. */
export function EmptyState(
  {
    action,
    description,
    icon,
    inset = "none",
    layout = "block",
    title,
    variant = "firstUse",
    ...props
  }: EmptyStateProps,
) {
  return (
    <section
      className={[
        "ui-empty-state",
        `ui-empty-state--${variant}`,
        layout === "centered" ? "ui-empty-state--centered" : "",
      ].filter(Boolean).join(" ")}
      {...props}
      data-inset={inset === "page" ? "page" : undefined}
      data-state="default"
      data-ui-component="emptyState"
      data-variant={variant}
    >
      {icon ? <div className="ui-empty-state__icon">{icon}</div> : null}
      <h2 className="ui-feedback-title">{title}</h2>
      {description
        ? <div className="ui-feedback-description">{description}</div>
        : null}
      {action ? <div className="ui-feedback-action">{action}</div> : null}
    </section>
  );
}
