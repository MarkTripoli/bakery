import type { ReactNode, SelectHTMLAttributes } from "react";
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
    /**
     * A help tip for the control, shown on the label line at the end of the
     * control's width. It sits beside the label, not inside it, because a label
     * may not contain another control.
     */
    help?: ReactNode;
    multiple?: boolean;
    options: ComboboxOption[];
    state?: "closed" | "open" | "loading" | "empty" | "selected" | "disabled";
    variant?: "single" | "multiple";
  };

export function Combobox(
  {
    appearance = "field",
    label,
    help,
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
  const control = (
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
            {help === undefined
              ? label
              : <span className="ui-combobox__label-text">{label}</span>}
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
  if (help === undefined) return control;
  return (
    <div className="ui-combobox-help" data-ui-component="comboboxHelp">
      {control}
      <span className="ui-combobox__help">{help}</span>
    </div>
  );
}
