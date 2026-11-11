import type { HTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type PopoverProps =
  & Omit<SemanticNativeProps<HTMLAttributes<HTMLDivElement>>, "title">
  & {
    children: ReactNode;
    defaultOpen?: boolean;
    /** `toolbar` frames the trigger as a compact secondary button. */
    triggerAppearance?: "plain" | "toolbar";
    label: string;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    trigger: ReactNode;
    variant?: "information" | "interactive";
  };

/** Shows compact secondary content from an explicit trigger. */
export function Popover(
  {
    children,
    defaultOpen = false,
    label,
    onOpenChange,
    open,
    trigger,
    triggerAppearance = "plain",
    variant = "information",
    ...unsafeProps
  }: PopoverProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const isOpen = open ?? uncontrolledOpen;
  const resolvedState = isOpen ? "open" : "closed";
  const setOpen = (nextOpen: boolean) => {
    if (open === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen) triggerRef.current?.focus();
  };
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  useEffect(() => {
    if (!isOpen) return;
    contentRef.current?.focus();
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpenRef.current(false);
        }
        return;
      }
      if (
        !contentRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) setOpenRef.current(false);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [isOpen]);

  return (
    <span
      className="ui-popover"
      data-state={resolvedState}
      data-variant={variant}
      data-ui-component="popover"
    >
      <button
        aria-expanded={isOpen}
        aria-controls={contentId}
        aria-haspopup="dialog"
        className={`ui-popover__trigger ui-popover__trigger--${triggerAppearance}`}
        onClick={() => setOpen(!isOpen)}
        ref={triggerRef}
        type="button"
      >
        {trigger}
      </button>
      {isOpen
        ? (
          <div
            aria-label={label}
            className={[
              "ui-popover__content",
              `ui-popover__content--${variant}`,
            ].filter(Boolean).join(" ")}
            id={contentId}
            ref={contentRef}
            role="dialog"
            tabIndex={-1}
            {...props}
          >
            {children}
          </div>
        )
        : null}
    </span>
  );
}
