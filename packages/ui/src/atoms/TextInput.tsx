import type { ChangeEvent } from "react";
import "../controls.css";

const LONG_COPY_THRESHOLD = 64;

export type TextInputProps = {
  autoComplete: string;
  describedBy?: string;
  disabled?: boolean;
  id: string;
  inputMode?:
    | "text"
    | "email"
    | "numeric"
    | "tel"
    | "url"
    | "search"
    | "none"
    | "decimal";
  invalid?: boolean;
  name: string;
  min?: number;
  max?: number;
  step?: number;
  onBlur?: () => void;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  required?: boolean;
  type: "text" | "email" | "number";
  value: string;
};

/** A single-line labelled control for short text, email, or number values. */
export function TextInput(
  {
    autoComplete,
    describedBy,
    disabled = false,
    id,
    inputMode,
    invalid = false,
    name,
    min,
    max,
    step,
    onBlur,
    onChange,
    placeholder,
    readOnly = false,
    required = false,
    type,
    value,
  }: TextInputProps,
) {
  const state = disabled
    ? "disabled"
    : readOnly
    ? "readonly"
    : invalid
    ? "invalid"
    : value.length > LONG_COPY_THRESHOLD
    ? "long-copy"
    : "default";
  return (
    <div
      data-state={state}
      data-ui-component="textInput"
      data-variant={type}
    >
      <input
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete={autoComplete}
        className="ui-text-input"
        disabled={disabled}
        id={id}
        inputMode={inputMode}
        name={name}
        min={min}
        max={max}
        step={step}
        onBlur={onBlur}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        required={required}
        type={type}
        value={value}
      />
    </div>
  );
}
