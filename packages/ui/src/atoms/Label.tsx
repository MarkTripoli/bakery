import type { LabelHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type LabelProps =
  & SemanticNativeProps<LabelHTMLAttributes<HTMLLabelElement>>
  & {
    children: ReactNode;
    disabled?: boolean;
    required?: boolean;
    state?: "default" | "required" | "disabled";
    variant?: "field" | "metadata";
  };

export function Label(
  {
    children,
    disabled = false,
    required = false,
    state,
    variant = "field",
    ...props
  }: LabelProps,
) {
  const resolvedState = state ??
    (disabled ? "disabled" : required ? "required" : "default");
  return (
    <label
      aria-disabled={resolvedState === "disabled" || undefined}
      className={`ui-label ui-label--${variant}`}
      {...props}
      data-state={resolvedState}
      data-ui-component="label"
      data-variant={variant}
    >
      {children}
      {resolvedState === "required"
        ? <span aria-hidden="true" className="ui-label__required">*</span>
        : null}
    </label>
  );
}
