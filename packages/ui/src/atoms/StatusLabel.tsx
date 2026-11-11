import type { HTMLAttributes, ReactNode } from "react";
import type { Status } from "./StatusBadge.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type StatusLabelProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    children: ReactNode;
    status: Status;
    updating?: boolean;
  };

export function StatusLabel(
  { children, status, updating = false, ...props }: StatusLabelProps,
) {
  return (
    <span
      aria-live={updating ? "polite" : undefined}
      className={["ui-status-label", `ui-status-label--${status}`].filter(
        Boolean,
      ).join(" ")}
      {...props}
      data-state={updating ? "updating" : "default"}
      data-ui-component="statusLabel"
      data-variant={status}
    >
      {updating ? "Updating: " : ""}
      {children}
    </span>
  );
}
