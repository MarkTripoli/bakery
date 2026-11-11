import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type ErrorStateProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    action?: ReactNode;
    description?: ReactNode;
    state?: "default" | "retrying";
    title: ReactNode;
    variant?: "region" | "page";
  };

/** Explains a load failure with a scoped recovery action. */
export function ErrorState(
  {
    action,
    description,
    state = "default",
    title,
    variant = "region",
    ...props
  }: ErrorStateProps,
) {
  const Title = variant === "page" ? "h1" : "h2";
  return (
    <section
      aria-busy={state === "retrying" || undefined}
      className={["ui-error-state", `ui-error-state--${variant}`].filter(
        Boolean,
      ).join(" ")}
      role="alert"
      {...props}
      data-ui-component="errorState"
      data-state={state}
      data-variant={variant}
    >
      <Title className="ui-feedback-title">{title}</Title>
      {description
        ? <div className="ui-feedback-description">{description}</div>
        : null}
      {action ? <div className="ui-feedback-action">{action}</div> : null}
    </section>
  );
}
