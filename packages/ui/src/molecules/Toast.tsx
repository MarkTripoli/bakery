import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type ToastProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    action?: ReactNode;
    children: ReactNode;
    onDismiss?: () => void;
    state?: "entering" | "visible" | "dismissed";
    tone?: "success" | "information" | "warning" | "error";
  };

/** Announces a concise result of a recent action. */
export function Toast(
  {
    action,
    children,
    onDismiss,
    state = "visible",
    tone = "information",
    ...props
  }: ToastProps,
) {
  if (state === "dismissed") {
    return (
      <div
        aria-hidden="true"
        className={["ui-toast", `ui-toast--${tone}`].join(" ")}
        {...props}
        data-state={state}
        data-ui-component="toast"
        data-variant={tone}
        hidden
      />
    );
  }
  return (
    <div
      aria-busy={state === "entering" || undefined}
      className={["ui-toast", `ui-toast--${tone}`].filter(Boolean).join(" ")}
      role={tone === "error" ? "alert" : "status"}
      {...props}
      data-state={state}
      data-ui-component="toast"
      data-variant={tone}
    >
      <div className="ui-toast__content">{children}</div>
      {action ? <div className="ui-toast__action">{action}</div> : null}
      {onDismiss
        ? (
          <button
            aria-label="Dismiss notification"
            className="ui-feedback-dismiss"
            onClick={onDismiss}
            type="button"
          >
            ×
          </button>
        )
        : null}
    </div>
  );
}
