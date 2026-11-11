import type { ChangeEvent, ClipboardEvent } from "react";
import "../controls.css";

export type OneTimeCodeInputProps = {
  disabled?: boolean;
  id: string;
  invalid?: boolean;
  kind: "totp" | "backup";
  name: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
};

/** A single control for a TOTP or backup recovery code, preserving leading zeros. */
export function OneTimeCodeInput(
  {
    disabled = false,
    id,
    invalid = false,
    kind,
    name,
    onChange,
    placeholder,
    value,
  }: OneTimeCodeInputProps,
) {
  const complete = kind === "totp" ? value.length === 6 : value.length > 0;
  const state = disabled
    ? "disabled"
    : invalid
    ? "invalid"
    : complete
    ? "complete"
    : "default";
  return (
    <div
      data-state={state}
      data-ui-component="oneTimeCodeInput"
      data-variant={kind}
    >
      <input
        aria-invalid={invalid || undefined}
        autoComplete={kind === "totp" ? "one-time-code" : "off"}
        className="ui-one-time-code-input"
        data-kind={kind}
        disabled={disabled}
        id={id}
        inputMode={kind === "totp" ? "numeric" : "text"}
        maxLength={kind === "totp" ? 6 : undefined}
        name={name}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const next = kind === "totp"
            ? event.target.value.replace(/[^0-9]/g, "").slice(0, 6)
            : event.target.value;
          onChange(next);
        }}
        onPaste={kind === "totp"
          ? (event: ClipboardEvent<HTMLInputElement>) => {
            const digits = event.clipboardData.getData("text").replace(
              /[^0-9]/g,
              "",
            ).slice(0, 6);
            onChange(digits);
            event.preventDefault();
          }
          : undefined}
        pattern={kind === "totp" ? "[0-9]*" : undefined}
        placeholder={placeholder}
        type="text"
        value={value}
      />
    </div>
  );
}
