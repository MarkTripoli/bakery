import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type StatusDotTone =
  | "warning"
  | "information"
  | "neutral"
  | "success"
  | "destructive";

export type StatusDotProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    children: ReactNode;
    /** `small` is the 12px table pill, `strong` the 13px medium page pill. */
    size?: "default" | "small" | "strong";
    tone: StatusDotTone;
  };

/** A stage or readiness label led by a tone dot; the text carries the meaning. */
export function StatusDot(
  { children, size = "default", tone, ...props }: StatusDotProps,
) {
  return (
    <span
      className={`ui-status-dot ui-status-dot--${tone} ui-status-dot--${size}`}
      {...props}
      data-state="default"
      data-ui-component="statusDot"
      data-variant={tone}
    >
      <span aria-hidden="true" className="ui-status-dot__dot" />
      <span className="ui-status-dot__label">{children}</span>
    </span>
  );
}
