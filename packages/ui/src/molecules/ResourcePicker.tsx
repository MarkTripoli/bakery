import type { ReactNode, SelectHTMLAttributes } from "react";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../data.css";

export type ResourceOption = {
  disabled?: boolean;
  label: ReactNode;
  value: string;
};
export type ResourcePickerProps =
  & Omit<
    SemanticNativeProps<SelectHTMLAttributes<HTMLSelectElement>>,
    "children" | "multiple"
  >
  & {
    error?: ReactNode;
    label: string;
    multiple?: boolean;
    options: ResourceOption[];
    state?:
      | "empty"
      | "searching"
      | "loading"
      | "selected"
      | "unavailable"
      | "error";
    variant?: "single" | "multiple";
  };

export function ResourcePicker(
  {
    disabled,
    error,
    label,
    multiple = false,
    options,
    state,
    variant,
    ...unsafeProps
  }: ResourcePickerProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const isMultiple = variant === "multiple" || multiple;
  const resolvedState = disabled ? "unavailable" : state ?? "empty";
  return (
    <label
      className={`ui-resource-picker ui-resource-picker--${
        isMultiple ? "multiple" : "single"
      }`}
      data-ui-component="resourcePicker"
      data-state={resolvedState}
      data-variant={isMultiple ? "multiple" : "single"}
    >
      {label}
      <select
        aria-busy={state === "searching" || state === "loading" || undefined}
        aria-invalid={state === "error" || undefined}
        multiple={isMultiple}
        {...props}
        disabled={disabled || state === "unavailable"}
      >
        {options.map((option) => (
          <option
            disabled={option.disabled}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
      {state === "empty" ? <span>No resources available.</span> : null}
      {error ? <span role="alert">{error}</span> : null}
    </label>
  );
}
