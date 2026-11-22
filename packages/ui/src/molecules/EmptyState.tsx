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
    /** `start` lines a centered layout up with the start edge of its column. */
    align?: "center" | "start";
    /** `column` stretches a block card across its whole column; `content` stops it at the readable content width. */
    span?: "content" | "column";
    /** `centered` fills its container with a quiet centered message. */
    layout?: "block" | "centered";
    /** `heading` makes the centered title a headline; `quiet` is the default. */
    titleStyle?: "quiet" | "heading";
    title: ReactNode;
    variant?: "firstUse" | "filtered" | "complete";
  };

/** Explains why a bounded collection has no content. */
export function EmptyState(
  {
    action,
    align = "center",
    description,
    icon,
    inset = "none",
    layout = "block",
    span = "content",
    title,
    titleStyle = "quiet",
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
      data-align={align === "start" ? "start" : undefined}
      data-inset={inset === "page" ? "page" : undefined}
      data-span={span === "column" ? "column" : undefined}
      data-state="default"
      data-title-style={titleStyle}
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
