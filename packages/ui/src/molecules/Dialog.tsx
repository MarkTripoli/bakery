import type { DialogHTMLAttributes, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { containDialogFocus, useNativeDialogOpen } from "./dialog-focus.ts";
import "../feedback.css";

export type DialogProps =
  & Omit<SemanticNativeProps<DialogHTMLAttributes<HTMLDialogElement>>, "open">
  & {
    children: ReactNode;
    defaultOpen?: boolean;
    dismissLabel?: string;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    state?: "closed" | "open" | "submitting" | "error";
    title: ReactNode;
    variant?: "form" | "information";
  };

/** Native modal dialog with browser-managed focus containment. */
export function Dialog(
  {
    children,
    defaultOpen = false,
    dismissLabel = "Close dialog",
    onClose,
    onCancel,
    onOpenChange,
    onKeyDown,
    open,
    state,
    title,
    "aria-labelledby": ariaLabelledby,
    variant = "information",
    ...props
  }: DialogProps,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const resolvedState = isOpen
    ? state === "closed" ? "open" : state ?? "open"
    : "closed";
  const setOpen = (nextOpen: boolean) => {
    if (open === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  useNativeDialogOpen(dialogRef, isOpen);

  return (
    <dialog
      {...props}
      aria-busy={resolvedState === "submitting" || undefined}
      aria-modal="true"
      aria-labelledby={ariaLabelledby ?? titleId}
      className={["ui-dialog", `ui-dialog--${variant}`].filter(Boolean).join(
        " ",
      )}
      data-ui-component="dialog"
      data-state={resolvedState}
      data-variant={variant}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) containDialogFocus(event);
      }}
      onCancel={(event) => {
        onCancel?.(event);
        if (!event.defaultPrevented) {
          event.preventDefault();
          setOpen(false);
        }
      }}
      onClose={(event) => {
        onClose?.(event);
        if (isOpen) setOpen(false);
      }}
      ref={dialogRef}
    >
      <div className="ui-dialog__header">
        <h2 className="ui-dialog__title" id={titleId}>{title}</h2>
        <button
          aria-label={dismissLabel}
          className="ui-feedback-dismiss"
          onClick={() => setOpen(false)}
          type="button"
        >
          ×
        </button>
      </div>
      <div className="ui-dialog__content">{children}</div>
    </dialog>
  );
}
