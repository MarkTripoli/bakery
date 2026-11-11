import { type InputHTMLAttributes, type ReactNode, useId } from "react";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../controls.css";

export type SearchFieldProps =
  & Omit<
    SemanticNativeProps<InputHTMLAttributes<HTMLInputElement>>,
    "type"
  >
  & {
    message?: ReactNode;
    state?: "empty" | "typing" | "loading" | "results" | "error";
    variant?: "local" | "server";
  };

export function SearchField(
  {
    "aria-busy": ariaBusy,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    message,
    state,
    variant = "local",
    ...unsafeProps
  }: SearchFieldProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const messageId = useId();
  const describedBy = [ariaDescribedBy, message ? messageId : undefined]
    .filter(Boolean).join(" ") || undefined;
  return (
    <div
      className={`ui-search-field ui-search-field--${variant}`}
      data-state={state}
      data-ui-component="searchField"
      data-variant={variant}
    >
      <input
        {...props}
        aria-busy={state === "loading" ? true : ariaBusy}
        aria-describedby={describedBy}
        aria-invalid={state === "error" ? true : ariaInvalid}
        className="ui-search-field__input"
        type="search"
      />
      <div
        aria-atomic="true"
        aria-live={state === "error" ? "assertive" : "polite"}
        className="ui-search-field__message"
        id={messageId}
        role={state === "error" ? "alert" : "status"}
      >
        {message}
      </div>
    </div>
  );
}
