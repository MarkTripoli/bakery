import { type ReactNode, type SelectHTMLAttributes, useId } from "react";
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
    /** `short` keeps a field that holds a short choice to 320px instead of the whole column. */
    width?: "default" | "short";
    label: string;
    /** What is wrong with the choice, in the field's error style under the control. */
    error?: ReactNode;
    /** Marks the choice as required, as a field does. */
    required?: boolean;
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
    error,
    help,
    required = false,
    multiple = false,
    options,
    width = "default",
    state,
    variant,
    ...unsafeProps
  }: ComboboxProps,
) {
  const errorId = useId();
  const props = withoutSemanticOwnerProps(unsafeProps);
  const isMultiple = variant === "multiple" || multiple;
  const resolvedState = props.disabled ? "disabled" : state ?? "closed";
  const control = (
    <label
      className={`ui-combobox ui-combobox--${
        isMultiple ? "multiple" : "single"
      } ui-combobox--${appearance}${
        width === "short" ? " ui-combobox--short" : ""
      }`}
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
              ? required
                // The text and its star are one item of the label's grid, so the star stays on the line.
                ? (
                  <span>
                    {label}
                    <span aria-hidden="true">*</span>
                  </span>
                )
                : label
              : (
                <span className="ui-combobox__label-text">
                  {label}
                  {required ? <span aria-hidden="true">*</span> : null}
                </span>
              )}
            <IconGlyph name="chevron-down" />
          </>
        )}
      <select
        aria-busy={state === "loading" || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        required={required || undefined}
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
  const helped = help === undefined
    ? control
    : (
      <div className="ui-combobox-help" data-ui-component="comboboxHelp">
        {control}
        <span className="ui-combobox__help">{help}</span>
      </div>
    );
  if (!error) return helped;
  return (
    <div className="ui-combobox-field" data-ui-component="comboboxField">
      {helped}
      <span id={errorId} className="ui-field__error" role="alert">{error}</span>
    </div>
  );
}
