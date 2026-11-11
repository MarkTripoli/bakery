import {
  cloneElement,
  type FocusEventHandler,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

type TooltipTriggerProps = {
  "aria-describedby"?: string;
  onBlur?: FocusEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
};

export type TooltipProps =
  & Omit<
    SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>,
    | "aria-describedby"
    | "children"
    | "onBlur"
    | "onFocus"
    | "onKeyDown"
    | "onPointerEnter"
    | "onPointerLeave"
    | "tabIndex"
  >
  & {
    children: ReactElement<TooltipTriggerProps>;
    content: ReactNode;
    variant?: "label" | "description";
  };

/** Supplies supplementary text on hover and keyboard focus. */
export function Tooltip(
  { children, content, variant = "label", ...props }: TooltipProps,
) {
  const descriptionId = useId();
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const interactionState = focused ? "focus" : hovered ? "open" : "closed";
  const describedBy = [
    children.props["aria-describedby"],
    descriptionId,
  ].filter(Boolean).join(" ");
  const trigger = cloneElement(children, {
    "aria-describedby": describedBy,
    onBlur: (event) => {
      children.props.onBlur?.(event);
      setFocused(false);
    },
    onFocus: (event) => {
      children.props.onFocus?.(event);
      setDismissed(false);
      setFocused(true);
    },
    onKeyDown: (event) => {
      children.props.onKeyDown?.(event);
      if (!event.defaultPrevented && event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
      }
    },
    onPointerEnter: (event) => {
      children.props.onPointerEnter?.(event);
      if (!event.defaultPrevented) {
        setDismissed(false);
        setHovered(true);
      }
    },
    onPointerLeave: (event) => {
      children.props.onPointerLeave?.(event);
      if (!event.defaultPrevented) setHovered(false);
    },
  });

  return (
    <span
      className={["ui-tooltip", `ui-tooltip--${variant}`].filter(Boolean).join(
        " ",
      )}
      {...props}
      data-dismissed={dismissed || undefined}
      data-state={dismissed ? "closed" : interactionState}
      data-ui-component="tooltip"
      data-variant={variant}
    >
      {trigger}
      <span className="ui-tooltip__content" id={descriptionId} role="tooltip">
        {content}
      </span>
    </span>
  );
}
