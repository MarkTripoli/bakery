import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type Status =
  | "online-preview"
  | "offline-preview"
  | "healthy"
  | "queued"
  | "active"
  | "needsInput"
  | "degraded"
  | "failed"
  | "disconnected"
  | "disabled";

export type StatusBadgeProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    children: ReactNode;
    status: Status;
  };

export function StatusBadge({ children, status, ...props }: StatusBadgeProps) {
  return (
    <span
      className={["ui-status-badge", `ui-status-badge--${status}`].filter(
        Boolean,
      ).join(" ")}
      {...props}
      data-state="default"
      data-ui-component="statusBadge"
      data-variant={status}
    >
      {children}
    </span>
  );
}
