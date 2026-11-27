import { type HTMLAttributes, type ReactNode, useEffect, useRef } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type ToastProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    action?: ReactNode;
    children: ReactNode;
    onDismiss?: () => void;
    state?: "entering" | "visible" | "dismissed";
    placement?: "inline" | "floating";
    tone?: "success" | "information" | "warning" | "error";
  };

/** Announces a concise result of a recent action. */
export function Toast(
  {
    action,
    children,
    onDismiss,
    placement = "inline",
    state = "visible",
    tone = "information",
    ...props
  }: ToastProps,
) {
  const floating = placement === "floating" && state !== "dismissed";
  const toast = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shown = toast.current;
    const held = room.current;
    if (!floating || shown === null || held === null) return;
    const reserve = new ResizeObserver(() => {
      const below = globalThis.innerHeight - shown.getBoundingClientRect().top;
      held.style.setProperty("min-block-size", `${Math.ceil(below)}px`);
    });
    reserve.observe(shown);
    return () => reserve.disconnect();
  }, [floating]);
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
  const message = (
    <div
      ref={toast}
      aria-busy={state === "entering" || undefined}
      className={["ui-toast", `ui-toast--${tone}`].filter(Boolean).join(" ")}
      role={tone === "error" ? "alert" : "status"}
      {...props}
      data-placement={placement}
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
  return floating
    ? (
      <>
        <div aria-hidden="true" className="ui-toast-room" ref={room} />
        {message}
      </>
    )
    : message;
}
