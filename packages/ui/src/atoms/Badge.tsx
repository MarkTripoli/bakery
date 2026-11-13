import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type BadgeProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    children: ReactNode;
    /**
     * `success` tints the plate with the success surface, e.g. "Current";
     * `warning` and `danger` do the same with the warning and destructive
     * pairs, for what needs care or blocks something. The text still says so.
     */
    tone?: "neutral" | "success" | "warning" | "danger";
  };

/**
 * A short inline tag — Paper's `.badge` / `.badge.success` (auth.css:8): a
 * 12px caption on a 4px-radius plate, 2px/7px padding, never wrapping. It
 * marks a row ("Current" on the active session), not a lifecycle status —
 * `StatusBadge` keeps the pill-shaped runtime status vocabulary.
 */
export function Badge({ children, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={["ui-badge", tone === "neutral" ? "" : `ui-badge--${tone}`]
        .filter(Boolean)
        .join(" ")}
      {...props}
      data-state="default"
      data-ui-component="badge"
      data-variant={tone}
    >
      {children}
    </span>
  );
}
