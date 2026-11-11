import type { SelectHTMLAttributes } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../data.css";

export type ComboboxOption = {
  disabled?: boolean;
  label: string;
  value: string;
};
export type ComboboxProps =
  & Omit<
    SemanticNativeProps<SelectHTMLAttributes<HTMLSelectElement>>,
    "children" | "multiple"
  >
  & {
    /** `filter` renders a compact toolbar control with a visually hidden label. */
    appearance?: "field" | "filter";
    label: string;
    multiple?: boolean;
    options: ComboboxOption[];
    state?: "closed" | "open" | "loading" | "empty" | "selected" | "disabled";
    variant?: "single" | "multiple";
  };

export function Combobox(
  {
    appearance = "field",
    label,
    multiple = false,
    options,
    state,
    variant,
    ...unsafeProps
  }: ComboboxProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const isMultiple = variant === "multiple" || multiple;
  const resolvedState = props.disabled ? "disabled" : state ?? "closed";
  return (
    <label
      className={`ui-combobox ui-combobox--${
        isMultiple ? "multiple" : "single"
      } ui-combobox--${appearance}`}
      data-ui-component="combobox"
      data-state={resolvedState}
      data-variant={isMultiple ? "multiple" : "single"}
    >
      {appearance === "filter"
        ? (
          <>
            <span className="ui-combobox__label">{label}</span>
            <IconGlyph name="chevron-down" />
          </>
        )
        : (
          <>
            {label}
            <IconGlyph name="chevron-down" />
          </>
        )}
      <select
        aria-busy={state === "loading" || undefined}
        multiple={isMultiple}
        {...props}
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
      {state === "empty" ? <span>No options available.</span> : null}
    </label>
  );
}
