import { type ChangeEvent, useState } from "react";
import { Icon } from "../atoms/Icon.tsx";
import { IconButton } from "../atoms/IconButton.tsx";
import type { TextInputProps } from "../atoms/TextInput.tsx";
import "../controls.css";

export type PasswordInputProps =
  & Omit<TextInputProps, "type">
  & {
    autoComplete: "current-password" | "new-password";
    revealLabels: { hide: string; show: string };
  };

/** A password control with an accessible reveal toggle. */
export function PasswordInput(
  {
    autoComplete,
    describedBy,
    disabled = false,
    id,
    inputMode,
    invalid = false,
    name,
    onBlur,
    onChange,
    placeholder,
    readOnly = false,
    required = false,
    revealLabels,
    value,
  }: PasswordInputProps,
) {
  const [revealed, setRevealed] = useState(false);
  const state = disabled
    ? "disabled"
    : invalid
    ? "invalid"
    : revealed
    ? "revealed"
    : "default";
  return (
    <div
      className="ui-password-input"
      data-state={state}
      data-ui-component="passwordInput"
      data-variant={autoComplete}
    >
      <input
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete={autoComplete}
        className="ui-password-input__field"
        disabled={disabled}
        id={id}
        inputMode={inputMode}
        name={name}
        onBlur={onBlur}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        required={required}
        type={revealed ? "text" : "password"}
        value={value}
      />
      <IconButton
        aria-controls={id}
        aria-pressed={revealed}
        disabled={disabled}
        label={revealed ? revealLabels.hide : revealLabels.show}
        onClick={() => setRevealed((current) => !current)}
        state={disabled ? "disabled" : revealed ? "pressed" : "default"}
        variant="compact"
      >
        <Icon size="large">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </Icon>
      </IconButton>
    </div>
  );
}
