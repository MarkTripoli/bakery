import type { ChangeEvent } from "react";
import "../controls.css";

export type SegmentedControlOption = {
  disabled?: boolean;
  label: string;
  value: string;
};
export type SegmentedControlProps = {
  "aria-label": string;
  name: string;
  onChange: (value: string) => void;
  options: readonly SegmentedControlOption[];
  state?: "default" | "selected" | "focus" | "disabled";
  variant?: "single" | "inline";
  value: string;
};

export function SegmentedControl(
  {
    "aria-label": ariaLabel,
    name,
    onChange,
    options,
    state,
    value,
    variant = "single",
  }: SegmentedControlProps,
) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className={`ui-segmented-control ui-segmented-control--${variant}`}
      data-ui-component="segmentedControl"
      data-state={state ?? "selected"}
      data-variant={variant}
    >
      {options.map((option) => (
        <label key={option.value}>
          <input
            checked={option.value === value}
            className="ui-segmented-control__input"
            disabled={option.disabled}
            name={name}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange(event.target.value)}
            type="radio"
            value={option.value}
          />
          <span className="ui-segmented-control__item">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
