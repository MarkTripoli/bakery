import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../controls.css";

export type IconButtonProps =
  & SemanticNativeProps<ButtonHTMLAttributes<HTMLButtonElement>>
  & {
    children: ReactNode;
    label: string;
    loading?: boolean;
    state?: "default" | "pressed" | "loading" | "disabled";
    variant?: "standard" | "compact" | "destructive";
  };

export function IconButton(
  {
    children,
    disabled,
    label,
    loading = false,
    state,
    type = "button",
    variant = "standard",
    ...props
  }: IconButtonProps,
) {
  const resolvedState = state ??
    (loading ? "loading" : disabled ? "disabled" : "default");
  return (
    <button
      aria-label={label}
      aria-busy={loading || undefined}
      className={`ui-icon-button ui-icon-button--${variant}`}
      {...props}
      data-state={resolvedState}
      data-ui-component="iconButton"
      data-variant={variant}
      disabled={disabled || loading}
      type={type}
    >
      {children}
    </button>
  );
}
