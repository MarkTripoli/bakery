import {
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../controls.css";

export type CheckboxProps =
  & Omit<
    SemanticNativeProps<InputHTMLAttributes<HTMLInputElement>>,
    "type"
  >
  & { children: ReactNode; mixed?: boolean };

export function Checkbox(
  { children, mixed = false, ...unsafeInputProps }: CheckboxProps,
) {
  const inputProps = withoutSemanticOwnerProps(unsafeInputProps);
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [uncontrolledChecked, setUncontrolledChecked] = useState(
    Boolean(inputProps.defaultChecked),
  );
  const isChecked = inputProps.checked === undefined
    ? uncontrolledChecked
    : inputProps.checked;
  const invalid = inputProps["aria-invalid"] === true ||
    inputProps["aria-invalid"] === "true";
  const variant = mixed ? "mixed" : isChecked ? "checked" : "unchecked";
  const state = inputProps.disabled
    ? "disabled"
    : invalid
    ? "invalid"
    : focused
    ? "focus"
    : "default";
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.indeterminate = mixed;
    const form = input.form;
    if (inputProps.checked !== undefined || !form) return;
    let disposed = false;
    const synchronizeReset = () => {
      globalThis.setTimeout(() => {
        if (disposed) return;
        setUncontrolledChecked(input.checked);
        input.indeterminate = mixed;
      });
    };
    form.addEventListener("reset", synchronizeReset);
    return () => {
      form.removeEventListener("reset", synchronizeReset);
      disposed = true;
    };
  }, [inputProps.checked, mixed]);
  return (
    <label
      className="ui-checkbox"
      data-state={state}
      data-ui-component="checkbox"
      data-variant={variant}
    >
      <input
        {...inputProps}
        aria-checked={mixed ? "mixed" : undefined}
        onBlur={(event) => {
          inputProps.onBlur?.(event);
          setFocused(false);
        }}
        onChange={(event) => {
          inputProps.onChange?.(event);
          if (inputProps.checked === undefined) {
            setUncontrolledChecked(event.currentTarget.checked);
          }
          if (mixed) {
            queueMicrotask(() => {
              if (inputRef.current) inputRef.current.indeterminate = true;
            });
          }
        }}
        onFocus={(event) => {
          inputProps.onFocus?.(event);
          setFocused(true);
        }}
        ref={inputRef}
        type="checkbox"
      />
      {children}
    </label>
  );
}
