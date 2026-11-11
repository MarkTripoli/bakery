import type { DialogHTMLAttributes, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { containDialogFocus, useNativeDialogOpen } from "./dialog-focus.ts";
import "../feedback.css";

export type AlertDialogProps =
  & Omit<
    SemanticNativeProps<DialogHTMLAttributes<HTMLDialogElement>>,
    "open" | "role"
  >
  & {
    cancelAction: ReactNode;
    children: ReactNode;
    confirmAction: ReactNode;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    state?: "closed" | "open" | "confirming" | "error";
    title: ReactNode;
    variant?: "destructive" | "security";
  };

/** Requests confirmation for a consequential action. */
export function AlertDialog(
  {
    "aria-describedby": ariaDescribedby,
    "aria-labelledby": ariaLabelledby,
    cancelAction,
    children,
    confirmAction,
    defaultOpen = false,
    onCancel,
    onClose,
    onKeyDown,
    onOpenChange,
    open,
    state,
    title,
    variant = "destructive",
    ...props
  }: AlertDialogProps,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const descriptionId = useId();
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
      aria-busy={resolvedState === "confirming" || undefined}
      aria-describedby={ariaDescribedby ?? descriptionId}
      aria-modal="true"
      aria-labelledby={ariaLabelledby ?? titleId}
      className={["ui-alert-dialog", `ui-alert-dialog--${variant}`].filter(
        Boolean,
      ).join(" ")}
      data-ui-component="alertDialog"
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
      role="alertdialog"
    >
      <h2 className="ui-dialog__title" id={titleId}>{title}</h2>
      <div className="ui-dialog__content" id={descriptionId}>{children}</div>
      <div className="ui-alert-dialog__actions">
        <span className="ui-alert-dialog__safe-action">{cancelAction}</span>
        {confirmAction}
      </div>
    </dialog>
  );
}
