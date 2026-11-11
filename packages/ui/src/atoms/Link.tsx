import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../controls.css";

export type LinkProps =
  & SemanticNativeProps<AnchorHTMLAttributes<HTMLAnchorElement>>
  & {
    children: ReactNode;
    state?: "default" | "hover" | "focus" | "visited";
    /**
     * `button` / `primaryButton` give navigation a secondary or primary
     * button frame (Paper E-0 "Open session", "New task"); `primaryIcon` is
     * the 44px square phone action (E8-0 "+") and needs an `aria-label`.
     */
    variant?:
      | "internal"
      | "external"
      | "quiet"
      | "button"
      | "primaryButton"
      | "primaryIcon"
      | "icon"
      | "back";
  };

export function Link({
  children,
  rel,
  target,
  state = "default",
  variant = "internal",
  ...props
}: LinkProps) {
  return (
    <a
      className={`ui-link ui-link--${variant}`}
      rel={rel ?? (variant === "external" ? "noreferrer" : undefined)}
      target={target ?? (variant === "external" ? "_blank" : undefined)}
      {...props}
      data-state={state}
      data-ui-component="link"
      data-variant={variant}
    >
      {children}
      {variant === "external" ? " (opens in a new tab)" : null}
    </a>
  );
}
