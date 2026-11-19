import type { ReactNode } from "react";
import "../controls.css";

export type FieldProps = {
  children: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  label: ReactNode;
  /**
   * A link or short action shown at the end of the label row, such as
   * "Forgot password?"; stacked layout only. It follows the control in tab and
   * reading order, so tabbing from the field before reaches the control first.
   */
  labelEnd?: ReactNode;
  /** Quiet line under an inline label, e.g. "Optional". */
  note?: ReactNode;
  /** `inline` puts the label in a left column beside the control (collapses to stacked on narrow screens). */
  layout?: "stacked" | "inline";
  required?: boolean;
  state?: "default" | "focus" | "invalid" | "disabled" | "readonly";
  variant?: "input" | "textarea" | "select";
};

export function Field(
  {
    children,
    error,
    hint,
    htmlFor,
    label,
    labelEnd,
    layout = "stacked",
    note,
    required = false,
    state = "default",
    variant = "input",
  }: FieldProps,
) {
  return (
    <div
      className={[
        "ui-field",
        `ui-field--${variant}`,
        `ui-field--${layout}`,
        labelEnd && layout === "stacked" ? "ui-field--label-end" : "",
      ].filter(Boolean).join(" ")}
      data-ui-component="field"
      data-variant={layout === "inline" ? "inline" : variant}
      data-has-hint={hint && !error ? "" : undefined}
      data-state={error && state === "default" ? "invalid" : state}
    >
      {layout === "inline"
        ? (
          <div className="ui-field__heading">
            <label htmlFor={htmlFor}>
              {label}
              {required ? <span aria-hidden="true">*</span> : null}
            </label>
            {note ? <span className="ui-field__note">{note}</span> : null}
          </div>
        )
        : (
          <label htmlFor={htmlFor}>
            {label}
            {required ? <span aria-hidden="true">*</span> : null}
          </label>
        )}
      {layout === "inline"
        ? (
          <div className="ui-field__body">
            {children}
            {error
              ? <div className="ui-field__error" role="alert">{error}</div>
              : null}
            {!error && hint
              ? <div className="ui-field__hint">{hint}</div>
              : null}
          </div>
        )
        : (
          <>
            {children}
            {error
              ? <div className="ui-field__error" role="alert">{error}</div>
              : null}
            {!error && hint
              ? <div className="ui-field__hint">{hint}</div>
              : null}
            {labelEnd && layout === "stacked"
              ? <div className="ui-field__label-end">{labelEnd}</div>
              : null}
          </>
        )}
    </div>
  );
}
